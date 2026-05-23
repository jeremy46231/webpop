export class Stopwatch {
  constructor(name) {
    this.name = name;
    this.marks = [];
  }
  mark(ms) {
    this.marks.push(ms);
    return this;
  }
  total() {
    return this.marks.reduce((a, b) => a + b, 0);
  }
}
