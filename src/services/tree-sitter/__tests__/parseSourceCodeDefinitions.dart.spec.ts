import { dartQuery } from "../queries"
import { testParseSourceCodeDefinitions } from "./helpers"
import sampleDartContent from "./fixtures/sample-dart"

const dartOptions = {
	language: "dart",
	wasmFile: "tree-sitter-dart.wasm",
	queryString: dartQuery,
	extKey: "dart",
}

describe("parseSourceCodeDefinitionsForFile with Dart", () => {
	it("captures a redirecting factory constructor", async () => {
		const content = `class Logger {
		  factory Logger() = ConsoleLogger;
		}

		class ConsoleLogger implements Logger {}`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)

		expect(result).toMatch(/\d+--\d+ \|\s*factory Logger\(\) = ConsoleLogger/)
	})

	it("captures a multiline generative constructor once", async () => {
		const content = `class Point {
		  Point.fromCoordinates(
		    int x,
		    int y,
		  );
		}`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)

		expect(result?.match(/\d+--\d+ \|\s*Point\.fromCoordinates\(/g)).toHaveLength(1)
	})

	it("captures a mixin application class", async () => {
		const content = `class Base {}
		mixin Serializable {}
		class SerializableBase = Base with Serializable;`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)

		expect(result).toMatch(/\d+--\d+ \|\s*class SerializableBase = Base with Serializable/)
	})

	it("captures external top-level functions and methods", async () => {
		const content = `external int nativeVersion();

		class NativeApi {
		  external String platformName();
		}`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)

		expect(result).toMatch(/\d+--\d+ \| external int nativeVersion\(\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*external String platformName\(\)/)
	})

	it("does not report local functions as file-level definitions", async () => {
		const content = `void outer() {
		  int inner() => 1;
		  print(inner());
		}`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)

		expect(result).toMatch(/\d+--\d+ \| void outer\(\)/)
		expect(result).not.toMatch(/int inner\(\)/)
	})

	it("includes a multiline top-level function body without duplicating its declaration", async () => {
		const content = `int add(int left, int right) {
		  final result = left + right;
		  return result;
		}`

		const result = await testParseSourceCodeDefinitions("/test/file.dart", content, dartOptions)
		const addDefinitions = result?.split("\n").filter((line) => line.includes("int add(")) ?? []

		expect(addDefinitions).toEqual(["1--4 | int add(int left, int right) {"])
	})

	it("should capture common Dart declarations", async () => {
		const result = await testParseSourceCodeDefinitions("/test/file.dart", sampleDartContent, dartOptions)
		const definitionLines = result?.split("\n").filter((line) => line.includes(" | ")) ?? []

		expect(result).toMatch(/\d+--\d+ \| abstract class Animal/)
		expect(result).toMatch(/\d+--\d+ \|\s*Future<String> describe/)
		expect(result).toMatch(/\d+--\d+ \| class Point/)
		expect(result).toMatch(/\d+--\d+ \|\s*const Point\(\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*Point\.named\(\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*factory Point\.origin\(\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*Point\.fromCoordinates\(/)
		expect(result).toMatch(/\d+--\d+ \|\s*factory Point\.fromRecord\(/)
		expect(result?.match(/\d+--\d+ \|   Point\.fromCoordinates\(/g)).toHaveLength(1)
		expect(result?.match(/\d+--\d+ \|   factory Point\.fromRecord\(/g)).toHaveLength(1)
		expect(result).toMatch(/\d+--\d+ \|\s*int get x/)
		expect(result).toMatch(/\d+--\d+ \|\s*set x\(int value\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*Point operator \+/)
		expect(result).toMatch(/\d+--\d+ \|\s*Point operator \[]/)
		expect(result).toMatch(/\d+--\d+ \|\s*static List<T> emptyList/)
		expect(result).toMatch(/\d+--\d+ \| mixin Runner/)
		expect(result).toMatch(/\d+--\d+ \| enum Status/)
		expect(result).toMatch(/\d+--\d+ \|\s*const Status\(\)/)
		expect(result).toMatch(/\d+--\d+ \| class Dog extends Animal with Runner/)
		expect(result).toMatch(/\d+--\d+ \| extension StringTools on String/)
		expect(result).toMatch(/\d+--\d+ \| extension on int/)
		expect(result).toMatch(/\d+--\d+ \| extension type UserId/)
		expect(result).toMatch(/\d+--\d+ \| typedef Operation/)
		expect(result).toMatch(/\d+--\d+ \| typedef AsyncOperation/)
		expect(result).toMatch(/\d+--\d+ \| int get answer/)
		expect(result).toMatch(/\d+--\d+ \| set answer\(int value\)/)
		expect(result).toMatch(/\d+--\d+ \|\s*String speak\(\)/)
		expect(result).toMatch(/\d+--\d+ \| int add\(int left, int right\)/)
		expect(result).toMatch(/\d+--\d+ \| Future<T> retry<T extends Object>/)
		expect(result).toMatch(/\d+--\d+ \| Future<void> initialize\(\) async/)
		expect(result).toMatch(/\d+--\d+ \| Iterable<int> countUpTo\(int maximum\) sync\*/)
		expect(result).toMatch(/\d+--\d+ \| Stream<int> countPeriodically\(int maximum\) async\*/)
		expect(definitionLines).toHaveLength(37)
	})
})
