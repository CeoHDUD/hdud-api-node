export class Confidence {
  constructor(value = 0) {
    const n = Number(value);
    this.value = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  percent() {
    return Math.round(this.value * 100);
  }

  toJSON() {
    return { value: this.value, percent: this.percent() };
  }
}
