# Serving via Tailscale

O Core deve continuar em loopback:

```text
HOST=127.0.0.1
PORT=3000
```

Depois de validar localmente, exponha somente para a tailnet:

```bash
tailscale serve --bg 3000
tailscale serve status
```

O dashboard validado neste PC fica em `https://pc.tail14bdd9.ts.net/ui/` e o status esperado é `tailnet only` com proxy para `http://127.0.0.1:3000`.

Não usar `tailscale funnel`. Não abrir a porta do Core diretamente na LAN/WAN. A flag `JARVIS_TAILSCALE_SERVE_ENABLED=true` só informa o health; o estado real deve ser confirmado com `tailscale serve status`.
