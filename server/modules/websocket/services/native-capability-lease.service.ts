/** Native chat keeps authorization bounded even on idle sockets. Verification is
 * supplied by the owner, so renewals cannot change the bound session or revive expiry. */
export class NativeCapabilityLease {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private value: unknown, private expires: number,
    private readonly verify: (value: unknown) => number | null,
    private readonly close: () => void) {
    this.arm();
  }

  active(): boolean {
    if (this.stopped) return false;
    if (Date.now() >= this.expires || this.verifiedExpiry(this.value) === null) { this.expire(); return false; }
    return true;
  }

  renew(value: unknown): boolean {
    if (!this.active()) return false;
    const expiry = this.verifiedExpiry(value);
    if (expiry === null || expiry <= this.expires) { this.expire(); return false; }
    this.value = value; this.expires = expiry; this.arm();
    return true;
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  private verifiedExpiry(value: unknown): number | null {
    try { return this.verify(value); }
    catch { return null; }
  }

  private expire(): void {
    if (this.stopped) return;
    this.stop(); this.close();
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), Math.max(0, this.expires - Date.now()));
    this.timer.unref();
  }
}
