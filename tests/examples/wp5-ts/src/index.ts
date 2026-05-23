import { Shape, Circle, Rectangle } from './shapes';
import { describe } from './describe';

const shapes: Shape[] = [
  new Circle(5),
  new Rectangle(4, 6),
  new Circle(2.5),
];

for (const s of shapes) {
  console.log(describe(s));
}
