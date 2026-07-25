export default `abstract class Animal {
  String speak();

  Future<String> describe({
    required bool verbose,
  });
}

class Point {
  const Point();
  Point.named();
  factory Point.origin() => const Point();

  Point.fromCoordinates(
    int x,
    int y,
  ) : assert(x >= 0),
      assert(y >= 0);

  factory Point.fromRecord(
    ({int x, int y}) coordinates,
  ) => Point.fromCoordinates(
    coordinates.x,
    coordinates.y,
  );

  int get x => 0;
  set x(int value) {}

  Point operator +(Point other) => this;

  Point operator [](int index) => this;

  static List<T> emptyList<T extends Object>() {
    return <T>[];
  }
}

mixin Runner {
  void run() {
    print("running");
  }
}

enum Status {
  ready,
  running;

  const Status();
}

class Dog extends Animal with Runner {
  final String name;

  Dog(this.name);

  @override
  String speak() {
    return "\$name barks";
  }
}

extension StringTools on String {
  String doubled() {
    return this + this;
  }
}

extension on int {
  int squared() => this * this;
}

extension type UserId(int value) {
  UserId.zero() : value = 0;
}

typedef Operation = int Function(int left, int right);

typedef AsyncOperation<T extends Object> = Future<T> Function(
  T value, {
  required Duration timeout,
});

int get answer => 42;
set answer(int value) {}

int add(int left, int right) {
  return left + right;
}

Future<T> retry<T extends Object>(
  Future<T> Function() operation, {
  int attempts = 3,
}) async {
  return operation();
}

Future<void> initialize() async {
  await Future<void>.value();
}

Iterable<int> countUpTo(int maximum) sync* {
  for (var value = 0; value <= maximum; value++) {
    yield value;
  }
}

Stream<int> countPeriodically(int maximum) async* {
  for (var value = 0; value <= maximum; value++) {
    yield value;
  }
}
`
