// Definition captures adapted from tree-sitter-dart's canonical tags query:
// https://github.com/UserNobody14/tree-sitter-dart/blob/master/queries/tags.scm
export default `
(class_definition
  name: (identifier) @name) @definition.class

(class_definition
  (mixin_application_class
    (identifier) @name)) @definition.class

(type_alias
  (type_identifier) @name) @definition.type

(declaration
  (function_signature
    name: (identifier) @name)) @definition.method

(redirecting_factory_constructor_signature
  (identifier) @name) @definition.method

(method_signature) @definition.method

(constructor_signature
  name: (identifier) @name) @definition.method

(constant_constructor_signature
  (identifier) @name) @definition.method

(mixin_declaration
  (mixin)
  (identifier) @name) @definition.mixin

(extension_declaration
  name: (identifier) @name) @definition.extension

(extension_type_declaration
  name: (identifier) @name) @definition.extension

(enum_declaration
  name: (identifier) @name) @definition.enum

(program
  (getter_signature
    name: (identifier) @name) @definition.function)

(program
  (setter_signature
    name: (identifier) @name) @definition.function)

(program
  (function_signature
    name: (identifier) @name) @definition.function)
`
