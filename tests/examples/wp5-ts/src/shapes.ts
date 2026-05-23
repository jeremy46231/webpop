export interface Shape {
  readonly kind: string;
  area(): number;
  perimeter(): number;
}

export class Circle implements Shape {
  readonly kind = 'circle';
  constructor(public radius: number) {}
  area(): number {
    return Math.PI * this.radius ** 2;
  }
  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

export class Rectangle implements Shape {
  readonly kind = 'rectangle';
  constructor(public width: number, public height: number) {}
  area(): number {
    return this.width * this.height;
  }
  perimeter(): number {
    return 2 * (this.width + this.height);
  }
}
