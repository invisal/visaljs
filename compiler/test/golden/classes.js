// A base class and a derived one: class_setup, members with home objects,
// super() binding `this`, super.m() and a checked `this` in the derived constructor.
class Shape {
  constructor(name) {
    this.name = name;
  }
  describe() {
    return "a " + this.name;
  }
}
class Square extends Shape {
  constructor(side) {
    super("square");
    this.side = side;
  }
  describe() {
    return super.describe() + " of side " + this.side;
  }
}
print(new Square(2).describe());
