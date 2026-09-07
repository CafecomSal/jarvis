[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Validate', 'Start', 'Stop', 'Status', 'InstallTask', 'RemoveTask')]
    [string]$Mode = 'Status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ScriptPath = (Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
$script:ProjectRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $script:ScriptPath) '..\..')).Path
$script:DataRoot = Join-Path $script:ProjectRoot 'data\ops'
$script:LogRoot = Join-Path $script:DataRoot 'logs'
$script:LogFile = Join-Path $script:LogRoot 'supervisor.log'
$script:StatePath = Join-Path $script:DataRoot 'supervisor-state.json'
$script:StopMarker = Join-Path $script:DataRoot 'stop.requested'
$script:TaskName = 'Jarvis Core'
$script:TaskPath = '\'
$script:CoreBaseUrl = 'http://127.0.0.1:3000'
$script:OllamaBaseUrl = 'http://127.0.0.1:11434'
$script:CorePort = 3000
$script:PostgresPort = 5434
$script:OllamaPort = 11434
$script:SupervisorMutexName = 'Local\JarvisCoreSupervisor'
$script:PollSeconds = 5
$script:LogMaxBytes = 10MB
$script:LogBackups = 5

function Ensure-Directory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $Path -Force)
    }
}

function Protect-LogMessage {
    param([Parameter(Mandatory = $true)][string]$Message)

    $safe = $Message -replace "\r|\n", ' '
    $safe = $safe -replace '(?i)(authorization|password|token|secret|api[_-]?key)\s*[:=]\s*[^\s]+', '$1=<redacted>'
    $safe = $safe -replace '(?i)rtsp://[^\s]+', 'rtsp://<redacted>'
    return $safe
}

function Rotate-LogIfNeeded {
    if (-not (Test-Path -LiteralPath $script:LogFile -PathType Leaf)) {
        return
    }

    $length = (Get-Item -LiteralPath $script:LogFile).Length
    if ($length -lt $script:LogMaxBytes) {
        return
    }

    for ($index = $script:LogBackups - 1; $index -ge 1; $index -= 1) {
        $source = "$($script:LogFile).$index"
        $destination = "$($script:LogFile).$($index + 1)"
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force
        }
    }

    Move-Item -LiteralPath $script:LogFile -Destination "$($script:LogFile).1" -Force
}

function Write-OperationalLog {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level,
        [Parameter(Mandatory = $true)][string]$Message
    )

    Ensure-Directory -Path $script:LogRoot
    Rotate-LogIfNeeded
    $line = "[$((Get-Date).ToUniversalTime().ToString('o'))][$Level] $(Protect-LogMessage -Message $Message)"
    Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        $command = Get-Command -Name $Name -ErrorAction Stop | Select-Object -First 1
        if ($null -eq $command) {
            return $null
        }
        if ($command.PSObject.Properties.Name -contains 'Source' -and $command.Source) {
            return [string]$command.Source
        }
        if ($command.PSObject.Properties.Name -contains 'Path' -and $command.Path) {
            return [string]$command.Path
        }
        return [string]$command.Name
    } catch {
        return $null
    }
}

function Get-WindowsPowerShellPath {
    $candidate = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
    }
    $fallback = Get-CommandPath -Name 'powershell.exe'
    if ($fallback) {
        return $fallback
    }
    throw 'windows_powershell_unavailable'
}

function Get-EnvNames {
    $envPath = Join-Path $script:ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        return @()
    }

    $names = @()
    foreach ($line in (Get-Content -LiteralPath $envPath)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
            $names += $Matches[1]
        }
    }
    return @($names | Sort-Object -Unique)
}

function Get-EnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)

    $envPath = Join-Path $script:ProjectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        return $null
    }

    foreach ($line in (Get-Content -LiteralPath $envPath)) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=\s*(.*)$") {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMilliseconds = 750
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.ConnectAsync('127.0.0.1', $Port)
        return [bool]($connect.Wait($TimeoutMilliseconds) -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [int]$IntervalSeconds = 5
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            if (& $Condition) {
                return $true
            }
        } catch {
            # Readiness is retried until the bounded deadline.
        }
        Start-Sleep -Seconds $IntervalSeconds
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Invoke-JsonGet {
    param([Parameter(Mandatory = $true)][string]$Uri)

    return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 5 -ErrorAction Stop
}

function Get-CoreHealth {
    try {
        $body = Invoke-JsonGet -Uri "$($script:CoreBaseUrl)/health"
        $hasStatus = $null -ne $body -and ($body.PSObject.Properties.Name -contains 'status')
        $hasModel = $null -ne $body -and ($body.PSObject.Properties.Name -contains 'model')
        return [pscustomobject]@{
            reachable = $true
            healthy = [bool]($hasStatus -and $body.status -eq 'ok')
            modelReported = [bool]$hasModel
        }
    } catch {
        return [pscustomobject]@{
            reachable = $false
            healthy = $false
            modelReported = $false
        }
    }
}

function Get-OllamaHealth {
    try {
        $body = Invoke-JsonGet -Uri "$($script:OllamaBaseUrl)/api/tags"
        $names = @()
        if ($null -ne $body -and $body.PSObject.Properties.Name -contains 'models') {
            foreach ($model in @($body.models)) {
                if ($null -ne $model -and $model.PSObject.Properties.Name -contains 'name') {
                    $names += [string]$model.name
                }
            }
        }
        $expected = Get-EnvValue -Name 'JARVIS_MODEL'
        if (-not $expected) {
            $expected = 'gemma-hermes:latest'
        }
        return [pscustomobject]@{
            reachable = $true
            modelAvailable = [bool]($names -contains $expected)
        }
    } catch {
        return [pscustomobject]@{
            reachable = $false
            modelAvailable = $false
        }
    }
}

function Test-DockerDaemon {
    $docker = Get-CommandPath -Name 'docker.exe'
    if (-not $docker) {
        $docker = Get-CommandPath -Name 'docker'
    }
    if (-not $docker) {
        return $false
    }

    try {
        $null = & $docker info --format '{{.ServerVersion}}' 2>$null
        return [bool]($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Get-PostgresContainerHealth {
    $docker = Get-CommandPath -Name 'docker.exe'
    if (-not $docker) {
        $docker = Get-CommandPath -Name 'docker'
    }
    if (-not $docker) {
        return 'unavailable'
    }

    try {
        $rawValue = & $docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' jarvis-postgres 2>$null
        $exitCode = $LASTEXITCODE
        $value = @($rawValue) | Select-Object -First 1
        if ($exitCode -ne 0 -or -not $value) {
            return 'missing'
        }
        return ([string]$value).Trim()
    } catch {
        return 'unknown'
    }
}

function Get-PostgresHealth {
    $portOpen = Test-TcpPort -Port $script:PostgresPort
    $containerHealth = Get-PostgresContainerHealth
    return [pscustomobject]@{
        portOpen = $portOpen
        containerHealth = $containerHealth
        healthy = [bool]($portOpen -and $containerHealth -eq 'healthy')
    }
}

function Get-TailscaleHealth {
    $tailscale = Get-CommandPath -Name 'tailscale.exe'
    if (-not $tailscale) {
        $tailscale = Get-CommandPath -Name 'tailscale'
    }
    if (-not $tailscale) {
        return [pscustomobject]@{ installed = $false; checked = $false; commandSucceeded = $false }
    }

    try {
        $null = & $tailscale serve status 2>$null
        return [pscustomobject]@{ installed = $true; checked = $true; commandSucceeded = [bool]($LASTEXITCODE -eq 0) }
    } catch {
        return [pscustomobject]@{ installed = $true; checked = $true; commandSucceeded = $false }
    }
}

function Test-CurrentTaskUser {
    param([AllowNull()][string]$TaskUser)

    if ([string]::IsNullOrWhiteSpace($TaskUser)) {
        return $false
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $shortUser = [Environment]::UserName
    $qualifiedUser = if ($env:COMPUTERNAME) { "$($env:COMPUTERNAME)\$shortUser" } else { '' }
    $knownUsers = @($identity.User.Value, $identity.Name, $shortUser, $qualifiedUser) | Where-Object { $_ }
    return [bool]($knownUsers -contains $TaskUser)
}

function Get-TaskReadback {
    try {
        $task = Get-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction Stop
        $info = Get-ScheduledTaskInfo -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction Stop
        $action = @($task.Actions) | Select-Object -First 1
        $trigger = @($task.Triggers) | Select-Object -First 1
        $expectedScript = [regex]::Escape($script:ScriptPath)
        $actionCommandMatches = $null -ne $action -and [string]$action.Execute -match '(?i)(^|\\)powershell\.exe$'
        $actionWorkingDirectoryMatches = $null -ne $action -and [string]$action.WorkingDirectory -eq $script:ProjectRoot
        $actionMatches = $actionCommandMatches -and $actionWorkingDirectoryMatches -and [string]$action.Arguments -match $expectedScript -and [string]$action.Arguments -match '(?i)-Mode\s+Start'
        $principalUser = if ($null -ne $task.Principal) { [string]$task.Principal.UserId } else { '' }
        $principalMatches = (Test-CurrentTaskUser -TaskUser $principalUser) -and $null -ne $task.Principal -and [string]$task.Principal.LogonType -match '(?i)^(InteractiveToken|Interactive)$' -and [string]$task.Principal.RunLevel -match '(?i)^(LeastPrivilege|Limited)$'
        $triggerUser = if ($null -ne $trigger) { [string]$trigger.UserId } else { '' }
        $triggerUserMatches = Test-CurrentTaskUser -TaskUser $triggerUser
        $triggerMatches = $null -ne $trigger -and [string]$trigger.CimClass.CimClassName -match 'LogonTrigger' -and $triggerUserMatches
        $settingsMatches = $null -ne $task.Settings -and [string]$task.Settings.MultipleInstances -match '(?i)IgnoreNew'
        $taskState = if ($task.PSObject.Properties.Name -contains 'State') { [string]$task.State } else { 'unknown' }

        return [pscustomobject]@{
            exists = $true
            readable = $true
            state = $taskState
            actionMatches = [bool]$actionMatches
            actionCommandMatches = [bool]$actionCommandMatches
            actionWorkingDirectoryMatches = [bool]$actionWorkingDirectoryMatches
            principalMatches = [bool]$principalMatches
            triggerMatches = [bool]$triggerMatches
            triggerUserMatches = [bool]$triggerUserMatches
            settingsMatches = [bool]$settingsMatches
            matches = [bool]($actionMatches -and $principalMatches -and $triggerMatches -and $settingsMatches)
        }
    } catch {
        $message = [string]$_.Exception.Message
        if ($message -match '(?i)access is denied|acesso negado') {
            return [pscustomobject]@{
                exists = $null
                readable = $false
                state = 'unknown'
                actionMatches = $false
                actionCommandMatches = $false
                actionWorkingDirectoryMatches = $false
                principalMatches = $false
                triggerMatches = $false
                triggerUserMatches = $false
                settingsMatches = $false
                matches = $false
            }
        }
        return [pscustomobject]@{
            exists = $false
            readable = $true
            state = 'missing'
            actionMatches = $false
            actionCommandMatches = $false
            actionWorkingDirectoryMatches = $false
            principalMatches = $false
            triggerMatches = $false
            triggerUserMatches = $false
            settingsMatches = $false
            matches = $false
        }
    }
}

function Get-ValidationReport {
    $envNames = Get-EnvNames
    $checks = [ordered]@{
        projectRoot = (Test-Path -LiteralPath $script:ProjectRoot -PathType Container)
        envFile = (Test-Path -LiteralPath (Join-Path $script:ProjectRoot '.env') -PathType Leaf)
        databaseConfigured = [bool]($envNames -contains 'DATABASE_URL' -and (Get-EnvValue -Name 'DATABASE_URL'))
        compiledCore = (Test-Path -LiteralPath (Join-Path $script:ProjectRoot 'dist\src\server.js') -PathType Leaf)
        node = [bool](Get-CommandPath -Name 'node.exe')
        docker = [bool]((Get-CommandPath -Name 'docker.exe') -or (Get-CommandPath -Name 'docker'))
        dockerDaemon = (Test-DockerDaemon)
        ollama = [bool]((Get-CommandPath -Name 'ollama.exe') -or (Get-CommandPath -Name 'ollama'))
        tailscale = [bool]((Get-CommandPath -Name 'tailscale.exe') -or (Get-CommandPath -Name 'tailscale'))
    }
    $required = @('projectRoot', 'envFile', 'databaseConfigured', 'compiledCore', 'node', 'docker', 'dockerDaemon', 'ollama')
    $ready = $true
    foreach ($name in $required) {
        if (-not [bool]$checks[$name]) {
            $ready = $false
        }
    }

    return [pscustomobject]@{
        ready = $ready
        checks = [pscustomobject]$checks
        note = 'Tailscale is verified separately and is not required to start the local Core.'
    }
}

function New-DefaultState {
    return [pscustomobject]@{
        version = 2
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        corePid = $null
        coreOwned = $false
        coreStartTimeUtc = $null
        ollamaPid = $null
        ollamaOwned = $false
        ollamaStartTimeUtc = $null
        postgresOwned = $false
        restartCount = 0
        lastError = $null
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $script:StatePath -PathType Leaf)) {
        return (New-DefaultState)
    }

    try {
        $state = Get-Content -Raw -LiteralPath $script:StatePath | ConvertFrom-Json
        if ($null -eq $state -or $state -is [array]) {
            return (New-DefaultState)
        }
        foreach ($property in (New-DefaultState).PSObject.Properties) {
            if ($state.PSObject.Properties.Name -notcontains $property.Name) {
                $state | Add-Member -MemberType NoteProperty -Name $property.Name -Value $property.Value
            }
        }
        return $state
    } catch {
        return (New-DefaultState)
    }
}

function Write-State {
    param([Parameter(Mandatory = $true)]$State)

    Ensure-Directory -Path $script:DataRoot
    $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    $temporary = "$($script:StatePath).tmp"
    $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $script:StatePath -Force
}

function Remove-StateAndMarker {
    if (Test-Path -LiteralPath $script:StatePath -PathType Leaf) {
        Remove-Item -LiteralPath $script:StatePath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $script:StopMarker -PathType Leaf) {
        Remove-Item -LiteralPath $script:StopMarker -Force -ErrorAction SilentlyContinue
    }
}

function Start-BackgroundProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$LogStem
    )

    Ensure-Directory -Path $script:LogRoot
    $stdout = Join-Path $script:LogRoot "$LogStem.stdout.log"
    $stderr = Join-Path $script:LogRoot "$LogStem.stderr.log"
    return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $script:ProjectRoot `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
}

function Get-DescendantProcessIds {
    param([Parameter(Mandatory = $true)][int]$ParentId)

    $result = @()
    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
        $pending = @($ParentId)
        while ($pending.Count -gt 0) {
            $current = [int]$pending[0]
            if ($pending.Count -eq 1) {
                $pending = @()
            } else {
                $pending = @($pending[1..($pending.Count - 1)])
            }
            foreach ($process in $processes) {
                if ([int]$process.ParentProcessId -eq $current -and $result -notcontains [int]$process.ProcessId) {
                    $result += [int]$process.ProcessId
                    $pending += [int]$process.ProcessId
                }
            }
        }
    } catch {
        return @()
    }
    return @($result)
}

function Get-ProcessStartTimeUtc {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return $process.StartTime.ToUniversalTime().ToString('o')
    } catch {
        try {
            $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
            if ($null -eq $process -or -not $process.CreationDate) {
                return $null
            }
            return ([System.Management.ManagementDateTimeConverter]::ToDateTime($process.CreationDate)).ToUniversalTime().ToString('o')
        } catch {
            return $null
        }
    }
}

function Test-OwnedProcessIdentity {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [AllowNull()][string]$ExpectedStartTimeUtc
    )

    if ([string]::IsNullOrWhiteSpace($ExpectedStartTimeUtc)) {
        return $false
    }

    $actualStartTimeUtc = Get-ProcessStartTimeUtc -ProcessId $ProcessId
    if ([string]::IsNullOrWhiteSpace($actualStartTimeUtc)) {
        return $false
    }

    try {
        $expected = [DateTimeOffset]::Parse($ExpectedStartTimeUtc).ToUnixTimeMilliseconds()
        $actual = [DateTimeOffset]::Parse($actualStartTimeUtc).ToUnixTimeMilliseconds()
        return $expected -eq $actual
    } catch {
        return $false
    }
}

function Test-ProcessAlive {
    param([AllowNull()][int]$ProcessId)

    if ($ProcessId -le 0) {
        return $false
    }
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Stop-OwnedProcess {
    param(
        [AllowNull()][int]$ProcessId,
        [AllowNull()][string]$ExpectedStartTimeUtc,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($ProcessId -le 0 -or -not (Test-ProcessAlive -ProcessId $ProcessId)) {
        return $true
    }
    if (-not (Test-OwnedProcessIdentity -ProcessId $ProcessId -ExpectedStartTimeUtc $ExpectedStartTimeUtc)) {
        Write-OperationalLog -Level WARN -Message "$Label PID identity could not be verified; no process was terminated"
        return $false
    }

    $children = @(
        foreach ($childId in (Get-DescendantProcessIds -ParentId $ProcessId)) {
            $childStartTimeUtc = Get-ProcessStartTimeUtc -ProcessId ([int]$childId)
            if (-not [string]::IsNullOrWhiteSpace($childStartTimeUtc)) {
                [pscustomobject]@{ pid = [int]$childId; startTimeUtc = $childStartTimeUtc }
            }
        }
    )
    try {
        Stop-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        # The bounded forceful fallback below is restricted to this owned PID tree.
    }

    $stopped = Wait-Until -TimeoutSeconds 15 -IntervalSeconds 1 -Condition {
        -not (Test-ProcessAlive -ProcessId $ProcessId)
    }
    if (-not $stopped) {
        foreach ($child in ($children | Sort-Object -Property pid -Descending)) {
            $childAlive = Test-ProcessAlive -ProcessId ([int]$child.pid)
            $childOwned = Test-OwnedProcessIdentity -ProcessId ([int]$child.pid) -ExpectedStartTimeUtc ([string]$child.startTimeUtc)
            if ($childAlive -and $childOwned) {
                Stop-Process -Id ([int]$child.pid) -Force -ErrorAction SilentlyContinue
            }
        }
        $parentAlive = Test-ProcessAlive -ProcessId $ProcessId
        $parentOwned = Test-OwnedProcessIdentity -ProcessId $ProcessId -ExpectedStartTimeUtc $ExpectedStartTimeUtc
        if ($parentAlive -and $parentOwned) {
            Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        }
        if (Test-ProcessAlive -ProcessId $ProcessId) {
            Write-OperationalLog -Level WARN -Message "$Label process did not stop within the bounded timeout"
            return $false
        }
    }
    Write-OperationalLog -Level INFO -Message "$Label process stopped"
    return $true
}

function Start-Postgres {
    $current = Get-PostgresHealth
    if ($current.portOpen) {
        if ($current.healthy) {
            Write-OperationalLog -Level INFO -Message 'PostgreSQL already healthy; reusing existing container'
            return $false
        }
        throw 'postgres_port_occupied_or_unhealthy'
    }
    if (-not (Test-DockerDaemon)) {
        throw 'docker_daemon_unavailable'
    }

    $docker = Get-CommandPath -Name 'docker.exe'
    if (-not $docker) {
        $docker = Get-CommandPath -Name 'docker'
    }
    try {
        $null = & $docker compose up -d postgres 1>$null 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'compose_failed'
        }
    } catch {
        throw 'postgres_start_failed'
    }

    $ready = Wait-Until -TimeoutSeconds 120 -Condition {
        (Get-PostgresHealth).healthy
    }
    if (-not $ready) {
        throw 'postgres_readiness_timeout'
    }
    Write-OperationalLog -Level INFO -Message 'PostgreSQL became healthy'
    return $true
}

function Start-Ollama {
    $current = Get-OllamaHealth
    if ((Test-TcpPort -Port $script:OllamaPort) -and $current.reachable) {
        if (-not $current.modelAvailable) {
            throw 'ollama_expected_model_unavailable'
        }
        Write-OperationalLog -Level INFO -Message 'Ollama already reachable; reusing existing process'
        return [pscustomobject]@{ owned = $false; pid = $null; startTimeUtc = $null }
    }
    if (Test-TcpPort -Port $script:OllamaPort) {
        throw 'ollama_port_occupied_or_unhealthy'
    }

    $ollama = Get-CommandPath -Name 'ollama.exe'
    if (-not $ollama) {
        $ollama = Get-CommandPath -Name 'ollama'
    }
    $process = Start-BackgroundProcess -FilePath $ollama -ArgumentList @('serve') -LogStem 'ollama'
    $startTimeUtc = Get-ProcessStartTimeUtc -ProcessId $process.Id
    if ([string]::IsNullOrWhiteSpace($startTimeUtc)) {
        try { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue } catch { }
        throw 'ollama_process_identity_unavailable'
    }
    $ready = Wait-Until -TimeoutSeconds 120 -Condition {
        $health = Get-OllamaHealth
        [bool]($health.reachable -and $health.modelAvailable)
    }
    if (-not $ready) {
        $stopped = Stop-OwnedProcess -ProcessId $process.Id -ExpectedStartTimeUtc $startTimeUtc -Label 'Ollama'
        if (-not $stopped) {
            try { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue } catch { }
        }
        throw 'ollama_readiness_timeout_or_model_missing'
    }
    Write-OperationalLog -Level INFO -Message 'Ollama became ready with the configured model available'
    return [pscustomobject]@{ owned = $true; pid = [int]$process.Id; startTimeUtc = $startTimeUtc }
}

function Start-Core {
    $current = Get-CoreHealth
    if (Test-TcpPort -Port $script:CorePort) {
        if ($current.healthy) {
            Write-OperationalLog -Level INFO -Message 'Jarvis Core already healthy; reusing existing process'
            return [pscustomobject]@{ owned = $false; pid = $null; startTimeUtc = $null }
        }
        throw 'core_port_occupied_or_unhealthy'
    }

    $node = Get-CommandPath -Name 'node.exe'
    if (-not $node) {
        $node = Get-CommandPath -Name 'node'
    }
    $process = Start-BackgroundProcess -FilePath $node -ArgumentList @('--env-file=.env', 'dist\src\server.js') -LogStem 'core'
    $startTimeUtc = Get-ProcessStartTimeUtc -ProcessId $process.Id
    if ([string]::IsNullOrWhiteSpace($startTimeUtc)) {
        try { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue } catch { }
        throw 'core_process_identity_unavailable'
    }
    $ready = Wait-Until -TimeoutSeconds 60 -Condition {
        (Get-CoreHealth).healthy
    }
    if (-not $ready) {
        $stopped = Stop-OwnedProcess -ProcessId $process.Id -ExpectedStartTimeUtc $startTimeUtc -Label 'Jarvis Core'
        if (-not $stopped) {
            try { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue } catch { }
        }
        throw 'core_readiness_timeout'
    }
    Write-OperationalLog -Level INFO -Message 'Jarvis Core became healthy on loopback'
    return [pscustomobject]@{ owned = $true; pid = [int]$process.Id; startTimeUtc = $startTimeUtc }
}

function Stop-ManagedResources {
    $state = Read-State
    $cleanupSucceeded = $true
    if ([bool]$state.coreOwned) {
        $cleanupSucceeded = (Stop-OwnedProcess -ProcessId ([int]$state.corePid) -ExpectedStartTimeUtc ([string]$state.coreStartTimeUtc) -Label 'Jarvis Core') -and $cleanupSucceeded
    }
    if ([bool]$state.ollamaOwned) {
        $cleanupSucceeded = (Stop-OwnedProcess -ProcessId ([int]$state.ollamaPid) -ExpectedStartTimeUtc ([string]$state.ollamaStartTimeUtc) -Label 'Ollama') -and $cleanupSucceeded
    }

    if ([bool]$state.postgresOwned -and -not (Test-DockerDaemon)) {
        Write-OperationalLog -Level WARN -Message 'PostgreSQL was supervisor-owned but Docker is unavailable; ownership state was preserved'
        $cleanupSucceeded = $false
    } elseif ([bool]$state.postgresOwned) {
        $docker = Get-CommandPath -Name 'docker.exe'
        if (-not $docker) {
            $docker = Get-CommandPath -Name 'docker'
        }
        try {
            $null = & $docker compose stop postgres 1>$null 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw 'compose_stop_failed'
            }
            Write-OperationalLog -Level INFO -Message 'PostgreSQL container stopped because the supervisor started it'
        } catch {
            Write-OperationalLog -Level WARN -Message 'PostgreSQL stop returned an error; container was not removed'
            $cleanupSucceeded = $false
        }
    }
    if ($cleanupSucceeded) {
        Remove-StateAndMarker
    }
    return $cleanupSucceeded
}

function Start-Supervisor {
    Ensure-Directory -Path $script:DataRoot
    $mutex = New-Object System.Threading.Mutex($false, $script:SupervisorMutexName)
    $ownsMutex = $false
    $state = New-DefaultState
    try {
        $ownsMutex = $mutex.WaitOne(0)
        if (-not $ownsMutex) {
            Write-OperationalLog -Level WARN -Message 'Another Jarvis supervisor instance is already running; no duplicate was started'
            return
        }

        if (Test-Path -LiteralPath $script:StopMarker -PathType Leaf) {
            Write-OperationalLog -Level WARN -Message 'A previous stop request is still pending; no resources were started'
            throw 'stop_marker_present'
        }

        $validation = Get-ValidationReport
        if (-not $validation.ready) {
            Write-OperationalLog -Level ERROR -Message 'Supervisor preflight failed; Docker, compiled Core, database configuration, or required runtime was unavailable'
            $validation | ConvertTo-Json -Depth 5
            throw 'supervisor_preflight_failed'
        }

        Write-State -State $state
        $state.postgresOwned = Start-Postgres
        Write-State -State $state
        $ollama = Start-Ollama
        $state.ollamaOwned = [bool]$ollama.owned
        $state.ollamaPid = $ollama.pid
        $state.ollamaStartTimeUtc = $ollama.startTimeUtc
        Write-State -State $state
        $core = Start-Core
        $state.coreOwned = [bool]$core.owned
        $state.corePid = $core.pid
        $state.coreStartTimeUtc = $core.startTimeUtc
        Write-State -State $state

        $restartDelays = @(5, 15, 30)
        Write-OperationalLog -Level INFO -Message 'Jarvis supervisor is monitoring Core health with bounded restart policy'
        while ($true) {
            if (Test-Path -LiteralPath $script:StopMarker -PathType Leaf) {
                Write-OperationalLog -Level INFO -Message 'Stop request received'
                if (-not (Stop-ManagedResources)) {
                    throw 'managed_resource_stop_incomplete'
                }
                return
            }

            $health = Get-CoreHealth
            if (-not $health.healthy) {
                $state = Read-State
                if (-not [bool]$state.coreOwned) {
                    Write-OperationalLog -Level ERROR -Message 'An externally owned Core became unhealthy; no unknown process was terminated'
                    throw 'external_core_unhealthy'
                }
                if ([int]$state.restartCount -ge $restartDelays.Count) {
                    Write-OperationalLog -Level ERROR -Message 'Core restart limit reached; supervisor is stopping without starting another instance'
                    throw 'core_restart_limit_reached'
                }
                $delay = [int]$restartDelays[[int]$state.restartCount]
                Write-OperationalLog -Level WARN -Message "Core health failed; retrying after bounded backoff of $delay seconds"
                Start-Sleep -Seconds $delay
                try {
                    $replacement = Start-Core
                    $state.coreOwned = [bool]$replacement.owned
                    $state.corePid = $replacement.pid
                    $state.coreStartTimeUtc = $replacement.startTimeUtc
                    $state.restartCount = [int]$state.restartCount + 1
                    Write-State -State $state
                } catch {
                    $state.restartCount = [int]$state.restartCount + 1
                    $state.lastError = 'core_restart_failed'
                    Write-State -State $state
                    Write-OperationalLog -Level WARN -Message 'Core restart attempt failed; the next bounded attempt will be evaluated by the supervisor'
                }
            } else {
                $state = Read-State
                if ([int]$state.restartCount -ne 0) {
                    $state.restartCount = 0
                    $state.lastError = $null
                    Write-State -State $state
                }
            }
            Start-Sleep -Seconds 15
        }
    } catch {
        if ([bool]$state.coreOwned -or [bool]$state.ollamaOwned -or [bool]$state.postgresOwned) {
            try {
                Stop-ManagedResources
            } catch {
                # Preserve the original failure; cleanup is best effort and bounded.
            }
        }
        throw
    } finally {
        if ($ownsMutex) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

function Test-SupervisorMutexHeld {
    $mutex = New-Object System.Threading.Mutex($false, $script:SupervisorMutexName)
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        return (-not $acquired)
    } catch {
        # If mutex ownership cannot be determined, do not race a possible supervisor.
        return $true
    } finally {
        if ($acquired) {
            try { $mutex.ReleaseMutex() } catch { }
        }
        $mutex.Dispose()
    }
}

function Invoke-Stop {
    Ensure-Directory -Path $script:DataRoot
    Set-Content -LiteralPath $script:StopMarker -Value ((Get-Date).ToUniversalTime().ToString('o')) -Encoding UTF8

    $task = Get-TaskReadback
    if ($task.readable -and $task.exists -and [string]$task.state -eq 'Running') {
        try {
            Stop-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -ErrorAction Stop
        } catch {
            # The marker remains available for the running supervisor.
        }
    }

    $deadline = (Get-Date).AddSeconds(30)
    while (Test-SupervisorMutexHeld) {
        if ((Get-Date) -ge $deadline) {
            throw 'supervisor_stop_timeout'
        }
        Start-Sleep -Seconds 1
    }

    if (-not (Stop-ManagedResources)) {
        throw 'managed_resource_stop_incomplete'
    }
    Write-Output ((Get-ValidationReport | ConvertTo-Json -Depth 5))
}

function Get-TaskDefinitionXml {
    $powerShell = [System.Security.SecurityElement]::Escape((Get-WindowsPowerShellPath))
    $scriptPath = [System.Security.SecurityElement]::Escape($script:ScriptPath)
    $projectRoot = [System.Security.SecurityElement]::Escape($script:ProjectRoot)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $escapedSid = [System.Security.SecurityElement]::Escape($sid)
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Jarvis Core supervisor: PostgreSQL, Ollama and compiled Core only.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
      <UserId>$escapedSid</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escapedSid</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$powerShell</Command>
      <Arguments>-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;$scriptPath&quot; -Mode Start</Arguments>
      <WorkingDirectory>$projectRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Install-Task {
    $current = Get-TaskReadback
    if ($current.exists -eq $null) {
        throw 'task_readback_access_denied'
    }
    if ($current.exists -and -not $current.matches) {
        throw 'existing_task_does_not_belong_to_jarvis'
    }

    $xml = Get-TaskDefinitionXml
    if ($PSCmdlet.ShouldProcess("Scheduled Task $($script:TaskName)", 'Register')) {
        Register-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -Xml $xml -Force -ErrorAction Stop | Out-Null
        $readback = Get-TaskReadback
        if (-not $readback.readable -or -not $readback.matches) {
            throw 'task_readback_mismatch'
        }
        Write-OperationalLog -Level INFO -Message 'Scheduled Task Jarvis Core installed and read back successfully'
        Write-Output ($readback | ConvertTo-Json -Depth 5)
    } else {
        Write-Output '{"whatIf":true,"task":"Jarvis Core"}'
    }
}

function Remove-Task {
    $current = Get-TaskReadback
    if ($current.exists -eq $null) {
        throw 'task_readback_access_denied'
    }
    if (-not $current.exists) {
        Write-Output '{"removed":false,"reason":"missing"}'
        return
    }
    if (-not $current.matches) {
        throw 'existing_task_does_not_belong_to_jarvis'
    }
    if ([string]$current.state -eq 'Running') {
        throw 'stop_jarvis_before_removing_task'
    }

    if ($PSCmdlet.ShouldProcess("Scheduled Task $($script:TaskName)", 'Unregister')) {
        Unregister-ScheduledTask -TaskName $script:TaskName -TaskPath $script:TaskPath -Confirm:$false -ErrorAction Stop
        $readback = Get-TaskReadback
        if ($readback.exists -ne $false) {
            throw 'task_remove_readback_failed'
        }
        Write-OperationalLog -Level INFO -Message 'Scheduled Task Jarvis Core removed and read back as absent'
        Write-Output '{"removed":true}'
    } else {
        Write-Output '{"whatIf":true,"task":"Jarvis Core"}'
    }
}

function Get-Status {
    $core = Get-CoreHealth
    $ollama = Get-OllamaHealth
    $postgres = Get-PostgresHealth
    $task = Get-TaskReadback
    $state = Read-State
    $tailscale = Get-TailscaleHealth
    return [pscustomobject]@{
        projectRoot = $script:ProjectRoot
        taskName = $script:TaskName
        task = $task
        ports = [pscustomobject]@{
            core = [pscustomobject]@{ port = $script:CorePort; open = (Test-TcpPort -Port $script:CorePort); health = $core }
            postgres = [pscustomobject]@{ port = $script:PostgresPort; open = $postgres.portOpen; health = $postgres }
            ollama = [pscustomobject]@{ port = $script:OllamaPort; open = (Test-TcpPort -Port $script:OllamaPort); health = $ollama }
        }
        ownership = [pscustomobject]@{
            corePid = $state.corePid
            coreOwned = $state.coreOwned
            ollamaPid = $state.ollamaPid
            ollamaOwned = $state.ollamaOwned
            postgresOwned = $state.postgresOwned
        }
        tailscale = $tailscale
        safeDefaults = [pscustomobject]@{
            detectorAutostart = $false
            cloudSttPromotion = $false
            physicalActions = $false
            funnel = $false
        }
    }
}

try {
    switch ($Mode) {
        'Validate' {
            Get-ValidationReport | ConvertTo-Json -Depth 5
            break
        }
        'Status' {
            Get-Status | ConvertTo-Json -Depth 8
            break
        }
        'Start' {
            Start-Supervisor
            break
        }
        'Stop' {
            Invoke-Stop
            break
        }
        'InstallTask' {
            Install-Task
            break
        }
        'RemoveTask' {
            Remove-Task
            break
        }
    }
} catch {
    $message = [string]$_.Exception.Message
    if (-not $message) {
        $message = 'unknown_supervisor_error'
    }
    Write-Error (Protect-LogMessage -Message $message)
    exit 1
}
