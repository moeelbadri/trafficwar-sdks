import { parse } from "@babel/parser";
import traverseImport, { type Binding, type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";
import path from "node:path";

import type { CaptureIssue, StaticCapture } from "./catalog";

// Babel's CommonJS default is nested when loaded directly by Node ESM.
const traverse: typeof traverseImport = typeof traverseImport === "function"
  ? traverseImport
  : (traverseImport as unknown as { default: typeof traverseImport }).default;
const UNKNOWN = Symbol("unknown");
const CONSTRUCTOR = Symbol("TrafficWar");
const CLIENT = Symbol("client");
const CAPTURE = Symbol("capture");
const CALL = Symbol("capture.call");
const APPLY = Symbol("capture.apply");
type Value = string | number | boolean | null | undefined
  | typeof UNKNOWN | typeof CONSTRUCTOR | typeof CLIENT | typeof CAPTURE
  | typeof CALL | typeof APPLY | StaticObject | Value[];
interface StaticObject { fields: Map<string, Value>; unknownKeys: boolean }
interface Module { file: string; program: NodePath<t.Program> }
type SyntaxPath = NodePath<t.Node | null | undefined>;

// Babel's overloaded get() loses its singular/list shape on union node types.
function child(p: SyntaxPath, name: string): SyntaxPath {
  return p.get(name) as SyntaxPath;
}
function children(p: SyntaxPath, name: string): SyntaxPath[] {
  return p.get(name) as SyntaxPath[];
}

function object(fields: [string, Value][] = []): StaticObject {
  return { fields: new Map(fields), unknownKeys: false };
}
function isObject(value: Value): value is StaticObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isScalar(value: Value): value is string | number | boolean | null | undefined {
  return value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
}

/** Parse and resolve bindings without evaluating application code. */
export function analyzeSources(root: string, sources: Map<string, string>): {
  captures: StaticCapture[]; issues: CaptureIssue[]; incomplete: boolean;
} {
  const modules = new Map<string, Module>();
  const programs = new Map<t.Node, Module>();
  const captures: StaticCapture[] = [];
  const issues: CaptureIssue[] = [];
  let incomplete = false;
  let evaluations = 0;
  for (const [file, source] of sources) {
    try {
      const ast = parse(source, {
        sourceType: "unambiguous",
        plugins: ["typescript", "decorators-legacy", ...(/\.(?:tsx|jsx|js)$/.test(file) ? ["jsx" as const] : [])],
      });
      traverse(ast, {
        Program(program) {
          const module = { file, program };
          modules.set(file, module);
          programs.set(program.node, module);
        },
        TSEnumDeclaration(p) {
          // Babel's JS scope crawler does not register TypeScript enums.
          p.scope.registerBinding("let", p.get("id"), p);
        },
      });
      traverse(ast, { ReferencedIdentifier(p) {
        if (!p.isIdentifier()) return;
        const binding = p.scope.getBinding(p.node.name);
        if (binding?.path.isTSEnumDeclaration()) binding.reference(p);
      } });
    } catch (error) {
      incomplete = true;
      modules.delete(file);
      const line = (error as { loc?: { line?: number } }).loc?.line ?? 1;
      issues.push({ file: relative(file), line, fields: ["unparseable source"] });
    }
  }
  const resolving = new Set<t.Node>();

  function relative(file: string): string {
    return path.relative(root, file).split(path.sep).join("/");
  }
  function moduleOf(p: NodePath): Module {
    return programs.get(p.scope.getProgramParent().path.node)!;
  }
  function imported(p: NodePath, source: string, name: string): Value {
    if (source === "@trafficwar/node") {
      return name === "*" ? object([["TrafficWar", CONSTRUCTOR]]) : name === "TrafficWar" ? CONSTRUCTOR : UNKNOWN;
    }
    if (!source.startsWith(".")) return UNKNOWN;
    const base = path.resolve(path.dirname(moduleOf(p).file), source);
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].flatMap(ext => [stem + ext, path.join(base, "index" + ext)])];
    const module = candidates.map(file => modules.get(file)).find(Boolean);
    if (!module) { incomplete = true; return UNKNOWN; }
    return exported(module, name);
  }
  function exported(module: Module, name: string): Value {
    if (resolving.size > 128) { incomplete = true; return UNKNOWN; }
    if (resolving.has(module.program.node)) return UNKNOWN;
    resolving.add(module.program.node);
    try {
      const fields = new Map<string, Value>();
      for (const statement of module.program.get("body")) {
        if (statement.isExportDefaultDeclaration()) {
          fields.set("default", value(statement.get("declaration")));
        } else if (statement.isExportNamedDeclaration()) {
          const declaration = statement.get("declaration");
          if (declaration.node) {
            const names = declaration.isTSEnumDeclaration() ? [declaration.node.id.name] : Object.keys(declaration.getBindingIdentifiers());
            for (const key of names) {
              fields.set(key, bindingValue(statement.scope.getBinding(key)));
            }
          }
          for (const specifier of statement.get("specifiers")) {
            if (!specifier.isExportSpecifier()) continue;
            const key = specifier.node.exported;
            const local = specifier.node.local;
            const localName = local.name;
            fields.set(key.type === "Identifier" ? key.name : key.value,
              statement.node.source ? imported(statement, statement.node.source.value, localName) : bindingValue(statement.scope.getBinding(localName)));
          }
        } else if (statement.isExportAllDeclaration()) {
          const exports = imported(statement, statement.node.source.value, "*");
          if (isObject(exports)) for (const [key, v] of exports.fields) {
            if (key !== "default" && !fields.has(key)) fields.set(key, v);
          }
        }
      }
      return name === "*" ? { fields, unknownKeys: false } : fields.get(name) ?? UNKNOWN;
    } finally { resolving.delete(module.program.node); }
  }
  function typedClient(p: SyntaxPath): Value {
    const node = p.node as t.Identifier;
    const annotation = node.typeAnnotation;
    if (annotation?.type !== "TSTypeAnnotation" || annotation.typeAnnotation.type !== "TSTypeReference") return UNKNOWN;
    const type = annotation.typeAnnotation.typeName;
    if (type.type === "Identifier") {
      return bindingValue(p.scope.getBinding(type.name)) === CONSTRUCTOR ? CLIENT : UNKNOWN;
    }
    if (type.left.type === "Identifier") {
      const ns = bindingValue(p.scope.getBinding(type.left.name));
      return isObject(ns) && ns.fields.get(type.right.name) === CONSTRUCTOR ? CLIENT : UNKNOWN;
    }
    return UNKNOWN;
  }
  function bindingValue(binding: Binding | undefined): Value {
    if (!binding) return UNKNOWN;
    const p = binding.path;
    if (resolving.size > 128) { incomplete = true; return UNKNOWN; }
    if (resolving.has(p.node)) return UNKNOWN;
    resolving.add(p.node);
    try {
      if (p.isImportSpecifier()) {
        const name = p.node.imported;
        const result = imported(p, (p.parentPath.node as t.ImportDeclaration).source.value, name.type === "Identifier" ? name.name : name.value);
        return (isObject(result) || Array.isArray(result)) && unsafeObject(binding, result, new Set()) ? UNKNOWN : result;
      }
      if (p.isImportDefaultSpecifier() || p.isImportNamespaceSpecifier()) {
        const result = imported(p, (p.parentPath.node as t.ImportDeclaration).source.value, p.isImportDefaultSpecifier() ? "default" : "*");
        return (isObject(result) || Array.isArray(result)) && unsafeObject(binding, result, new Set()) ? UNKNOWN : result;
      }
      if (p.isTSEnumDeclaration()) {
        const result = object();
        let next: Value = 0;
        for (const member of p.get("members")) {
          const initial = member.get("initializer");
          const v: Value = initial.node ? value(initial) : next;
          const id = member.node.id;
          result.fields.set(id.type === "Identifier" ? id.name : id.value, v);
          next = typeof v === "number" ? v + 1 : UNKNOWN;
        }
        return unsafeObject(binding, result, new Set()) ? UNKNOWN : result;
      }
      if (!p.isVariableDeclarator()) {
        // Parameters, including a framework-injected TrafficWar client.
        const identifier = p.isIdentifier() ? p : child(p, "id");
        return !identifier.node ? UNKNOWN : typedClient(identifier);
      }
      let result = value(p.get("init"));
      const id = p.get("id");
      if (result === UNKNOWN && id.isIdentifier()) result = typedClient(id);
      if (id.isObjectPattern()) {
        for (const property of id.get("properties")) {
          if (property.isObjectProperty() && property.getBindingIdentifiers()[binding.identifier.name]) {
            result = field(result, property.node.computed ? value(property.get("key")) : key(property.get("key")));
            break;
          }
        }
      } else if (id.isArrayPattern()) {
        const index = id.node.elements.findIndex(element => element?.type === "Identifier" && element.name === binding.identifier.name);
        result = Array.isArray(result) ? result[index] ?? UNKNOWN : UNKNOWN;
      }
      if (!binding.constant) return result === CLIENT ? CLIENT : UNKNOWN;
      if ((isObject(result) || Array.isArray(result)) && unsafeObject(binding, result, new Set())) return UNKNOWN;
      return result;
    } finally { resolving.delete(p.node); }
  }
  function unsafeObject(binding: Binding, known: Value, seen: Set<Binding>): boolean {
    if (seen.has(binding)) return false;
    seen.add(binding);
    for (const reference of binding.referencePaths) {
      if (dead(reference)) continue;
      let use = reference;
      let projection = known;
      while (use.parentPath) {
        const parent = use.parentPath;
        if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && use.key === "object") {
          projection = field(projection, parent.node.computed ? value(child(parent, "property")) : key(child(parent, "property")));
          use = parent;
        } else if ((parent.isTSAsExpression() || parent.isTSSatisfiesExpression() || parent.isTSNonNullExpression()) && use.key === "expression") use = parent;
        else break;
      }
      const parent = use.parentPath;
      if (!parent) continue;
      if ((parent.isAssignmentExpression() && use.key === "left") || parent.isUpdateExpression() || (parent.isUnaryExpression({ operator: "delete" }))) return true;
      if (isScalar(projection)) continue;
      if (parent.isVariableDeclarator() && parent.node.id.type === "Identifier") {
        const alias = parent.scope.getBinding(parent.node.id.name);
        if (alias && unsafeObject(alias, projection, seen)) return true;
      }
      // Passing the object itself to opaque code may mutate it. Reading a
      // primitive property does not expose the containing object.
      if (parent.isCallExpression() || parent.isOptionalCallExpression()) {
        const callee = value(child(parent, "callee"));
        if (callee !== CAPTURE && callee !== CALL && callee !== APPLY) return true;
      }
      if (parent.isReturnStatement() || parent.isAssignmentExpression()) return true;
    }
    return false;
  }
  function key(p: SyntaxPath): Value {
    return p.isIdentifier() ? p.node.name : value(p);
  }
  function field(v: Value, k: Value): Value {
    if (typeof k !== "string" && typeof k !== "number") return UNKNOWN;
    if (v === CLIENT && (k === "capture" || k === "captureBatch")) return CAPTURE;
    if (v === CAPTURE && k === "call") return CALL;
    if (v === CAPTURE && k === "apply") return APPLY;
    if (isObject(v)) return v.fields.get(String(k)) ?? UNKNOWN;
    if (Array.isArray(v)) return v[Number(k)] ?? UNKNOWN;
    return UNKNOWN;
  }
  function value(p: SyntaxPath): Value {
    if (++evaluations > 100_000) { incomplete = true; return UNKNOWN; }
    if (!p.node) return UNKNOWN;
    if (p.isStringLiteral() || p.isNumericLiteral() || p.isBooleanLiteral()) return p.node.value;
    if (p.isNullLiteral()) return null;
    if (p.isIdentifier({ name: "undefined" }) && !p.scope.getBinding("undefined")) return undefined;
    if (p.isIdentifier()) return bindingValue(p.scope.getBinding(p.node.name));
    if (p.isTSAsExpression() || p.isTSTypeAssertion() || p.isTSSatisfiesExpression() || p.isTSNonNullExpression() || p.isTSInstantiationExpression()) return value(child(p, "expression"));
    if (p.isNewExpression()) return value(p.get("callee")) === CONSTRUCTOR ? CLIENT : UNKNOWN;
    if (p.isMemberExpression() || p.isOptionalMemberExpression()) {
      const name = p.node.computed ? value(child(p, "property")) : key(child(p, "property"));
      if (child(p, "object").isThisExpression() && typeof name === "string") {
        const cls = p.findParent(parent => parent.isClass());
        if (cls?.isClass()) for (const member of cls.get("body.body")) {
          if (member.isClassProperty() && !member.node.computed && key(member.get("key")) === name) {
            const typed = typedClient(member);
            return typed === CLIENT ? typed : value(member.get("value"));
          }
          if (member.isClassMethod({ kind: "constructor" })) for (const param of member.get("params")) {
            if (param.isTSParameterProperty()) {
              const identifier = param.get("parameter");
              if (identifier.isIdentifier({ name })) return typedClient(identifier);
            }
          }
        }
      }
      return field(value(child(p, "object")), name);
    }
    if (p.isCallExpression() || p.isOptionalCallExpression()) {
      const callee = child(p, "callee");
      const args = children(p, "arguments");
      if (callee.isIdentifier({ name: "require" }) && !callee.scope.getBinding("require") && args[0]?.isStringLiteral()) return imported(p, args[0].node.value, "*");
      if (callee.isMemberExpression() || callee.isOptionalMemberExpression()) {
        const name = callee.node.computed ? value(child(callee, "property")) : key(child(callee, "property"));
        if (name === "bind" && value(child(callee, "object")) === CAPTURE && args.length === 1) return CAPTURE;
      }
      return UNKNOWN;
    }
    if (p.isTemplateLiteral()) {
      let result = p.node.quasis[0]?.value.cooked ?? "";
      const expressions = p.get("expressions");
      for (let i = 0; i < expressions.length; i++) {
        const v = value(expressions[i]!);
        if (!isScalar(v)) return UNKNOWN;
        result += String(v) + (p.node.quasis[i + 1]?.value.cooked ?? "");
      }
      return result;
    }
    if (p.isUnaryExpression({ operator: "!" })) {
      const v = value(p.get("argument"));
      return isScalar(v) ? !v : UNKNOWN;
    }
    if (p.isBinaryExpression({ operator: "+" })) {
      const left = value(p.get("left")), right = value(p.get("right"));
      if (!isScalar(left) || !isScalar(right)) return UNKNOWN;
      if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
      if (typeof left === "number" && typeof right === "number") return left + right;
      return UNKNOWN;
    }
    if (p.isConditionalExpression()) {
      const test = value(p.get("test"));
      if (isScalar(test)) return value(p.get(test ? "consequent" : "alternate"));
      const left = value(p.get("consequent")), right = value(p.get("alternate"));
      return left === right ? left : UNKNOWN;
    }
    if (p.isLogicalExpression()) {
      const left = value(p.get("left"));
      if (!isScalar(left)) return UNKNOWN;
      return p.node.operator === "&&" ? (left ? value(p.get("right")) : left)
        : p.node.operator === "||" ? (left ? left : value(p.get("right")))
          : left == null ? value(p.get("right")) : left;
    }
    if (p.isObjectExpression()) {
      const result = object();
      for (const property of p.get("properties")) {
        if (property.isSpreadElement()) {
          const spread = value(property.get("argument"));
          if (!isObject(spread) || spread.unknownKeys) {
            result.fields.clear();
            result.unknownKeys = true;
          }
          if (isObject(spread)) for (const [k, v] of spread.fields) result.fields.set(k, v);
        } else if (property.isObjectProperty()) {
          const k = property.node.computed ? value(property.get("key")) : key(property.get("key"));
          if (typeof k === "string" || typeof k === "number") result.fields.set(String(k), value(property.get("value")));
          else { result.fields.clear(); result.unknownKeys = true; }
        } else if (property.isObjectMethod()) {
          const k = property.node.computed ? value(property.get("key")) : key(property.get("key"));
          if (typeof k === "string") result.fields.set(k, UNKNOWN);
          else { result.fields.clear(); result.unknownKeys = true; }
        }
      }
      return result;
    }
    if (p.isArrayExpression()) {
      const result: Value[] = [];
      for (const element of p.get("elements")) {
        if (element.isSpreadElement()) {
          const spread = value(element.get("argument"));
          if (Array.isArray(spread)) result.push(...spread);
          else result.push(UNKNOWN);
        } else result.push(value(element));
      }
      return result;
    }
    return UNKNOWN;
  }
  function dead(p: NodePath): boolean {
    for (let branch = p, parent = p.parentPath; parent; branch = parent, parent = parent.parentPath) {
      if (parent.isIfStatement() || parent.isConditionalExpression()) {
        const test = value(child(parent, "test"));
        if (isScalar(test) && ((branch.key === "consequent" && !test) || (branch.key === "alternate" && !!test))) return true;
      }
      if ((parent.isWhileStatement() || parent.isForStatement()) && branch.key === "body") {
        const test = value(child(parent, "test"));
        if (isScalar(test) && !test) return true;
      }
      if (parent.isLogicalExpression() && branch.key === "right") {
        const left = value(parent.get("left"));
        if (isScalar(left) && ((parent.node.operator === "&&" && !left) || (parent.node.operator === "||" && !!left) || (parent.node.operator === "??" && left != null))) return true;
      }
      if ((parent.isBlockStatement() || parent.isProgram()) && typeof branch.key === "number" && !branch.isFunctionDeclaration()) {
        if (children(parent, "body").slice(0, branch.key).some(statement => statement.isReturnStatement() || statement.isThrowStatement() || statement.isBreakStatement() || statement.isContinueStatement())) return true;
      }
    }
    return false;
  }
  function record(p: SyntaxPath, v: Value): void {
    if (Array.isArray(v)) {
      if (p.isArrayExpression()) {
        for (const element of p.get("elements")) record(element.node ? element : p,
          element.isSpreadElement() ? value(element.get("argument")) : value(element));
      } else v.forEach(entry => record(p, entry));
      return;
    }
    const event = field(v, "event"), label = field(v, "label");
    const file = relative(moduleOf(p as NodePath).file), line = p.node?.loc?.start.line ?? 1;
    if (typeof event === "string" && typeof label === "string") {
      const capture: StaticCapture = { event, label, file, line };
      for (const name of ["source", "span_kind", "operation_type"] as const) {
        const resolved = isObject(v) && v.fields.has(name) ? v.fields.get(name)
          : isObject(v) && !v.unknownKeys ? undefined : UNKNOWN;
        if (typeof resolved === "string") capture[name] = resolved;
        else if (resolved !== undefined) capture.station_known = false;
      }
      captures.push(capture);
    }
    else issues.push({ file, line, fields: [...(typeof event === "string" ? [] : ["event"]), ...(typeof label === "string" ? [] : ["label"])] });
  }
  for (const module of modules.values()) {
    module.program.traverse({
      "CallExpression|OptionalCallExpression"(call) {
        if (!call.isCallExpression() && !call.isOptionalCallExpression()) return;
        if (dead(call)) return;
        const callee = value(child(call, "callee"));
        if (callee !== CAPTURE && callee !== CALL && callee !== APPLY) return;
        const args = children(call, "arguments");
        let arg = args[callee === CAPTURE ? 0 : 1];
        let payload = arg ? value(arg) : UNKNOWN;
        if (callee === APPLY) {
          payload = Array.isArray(payload) ? payload[0] ?? UNKNOWN : UNKNOWN;
          if (arg?.isArrayExpression()) arg = arg.get("elements")[0];
        }
        record(arg ?? call, payload);
      },
    });
  }
  return { captures, issues, incomplete };
}
