/**
 * TS
 */

export type Keys<T> = keyof T

export type Values<T> = T[keyof T]

export type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
	? I
	: never

export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

export type AssertEqual<T extends true> = T
