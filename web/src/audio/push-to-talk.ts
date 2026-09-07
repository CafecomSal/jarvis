export class PushToTalkLatch {
  private pressed = false;
  private stopRequested = true;

  press(): void {
    this.pressed = true;
    this.stopRequested = false;
  }

  release(): void {
    this.pressed = false;
    this.stopRequested = true;
  }

  shouldStop(): boolean {
    return this.stopRequested || !this.pressed;
  }
}
