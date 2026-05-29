import type { StructuralAnalysis, CallGraphEntry } from "../../types.js";
import type { LanguageExtractor, TreeSitterNode } from "./types.js";
import { findChild, getStringValue, traverse } from "./base-extractor.js";

function firstNamedChild(node: TreeSitterNode | null): TreeSitterNode | null {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) return child;
  }
  return null;
}

function childAt(node: TreeSitterNode | null, index: number): TreeSitterNode | null {
  return node?.child(index) ?? null;
}

function findFirstIdentifier(node: TreeSitterNode | null): string | null {
  if (!node) return null;
  if (
    node.type === "identifier" ||
    node.type === "operator" ||
    node.type === "field_expression"
  ) {
    return node.text;
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    const ident = findFirstIdentifier(child);
    if (ident) return ident;
  }

  return null;
}

function unwrapSignatureNode(node: TreeSitterNode | null): TreeSitterNode | null {
  if (!node) return null;

  switch (node.type) {
    case "signature":
      return unwrapSignatureNode(firstNamedChild(node));
    case "where_expression":
    case "typed_expression":
      return unwrapSignatureNode(node.namedChild(0));
    default:
      return node;
  }
}

function extractReturnTypeFromSignature(node: TreeSitterNode | null): string | undefined {
  if (!node) return undefined;

  if (node.type === "signature") {
    return extractReturnTypeFromSignature(firstNamedChild(node));
  }

  if (node.type === "where_expression") {
    return extractReturnTypeFromSignature(node.namedChild(0));
  }

  if (node.type === "typed_expression") {
    const typeNode = node.namedChild(1);
    return typeNode?.text;
  }

  return undefined;
}

function extractArgumentListNode(node: TreeSitterNode | null): TreeSitterNode | null {
  if (!node) return null;

  switch (node.type) {
    case "signature":
      return extractArgumentListNode(firstNamedChild(node));
    case "where_expression":
    case "typed_expression":
      return extractArgumentListNode(node.namedChild(0));
    case "call_expression":
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === "argument_list") return child;
      }
      return null;
    default:
      return null;
  }
}

function extractParamName(node: TreeSitterNode | null): string | null {
  if (!node) return null;

  switch (node.type) {
    case "identifier":
    case "operator":
    case "field_expression":
      return node.text;

    case "typed_expression":
    case "assignment":
    case "where_expression":
      return extractParamName(node.namedChild(0));

    case "splat_expression": {
      const name = extractParamName(node.namedChild(0));
      return name ? `${name}...` : null;
    }

    default:
      return findFirstIdentifier(node);
  }
}

function extractParamsFromSignature(signatureNode: TreeSitterNode | null): string[] {
  const argsNode = extractArgumentListNode(signatureNode);
  if (!argsNode) return [];

  const params: string[] = [];
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    const name = extractParamName(child);
    if (name) params.push(name);
  }

  return params;
}

function extractFunctionNameFromSignature(signatureNode: TreeSitterNode | null): string | null {
  const normalized = unwrapSignatureNode(signatureNode);
  if (!normalized) return null;

  if (
    normalized.type === "identifier" ||
    normalized.type === "operator" ||
    normalized.type === "field_expression"
  ) {
    return normalized.text;
  }

  if (normalized.type === "call_expression") {
    return extractParamName(childAt(normalized, 0));
  }

  return findFirstIdentifier(normalized);
}

function extractShortFunction(node: TreeSitterNode): { name: string; params: string[] } | null {
  if (node.type !== "assignment") return null;

  const left = node.namedChild(0);
  const signature = unwrapSignatureNode(left);
  if (!signature || signature.type !== "call_expression") return null;

  const name = extractFunctionNameFromSignature(signature);
  if (!name) return null;

  return {
    name,
    params: extractParamsFromSignature(signature),
  };
}

function splitCommaSeparated(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseImportLikeStatement(
  node: TreeSitterNode,
  keyword: "import" | "using",
): StructuralAnalysis["imports"] {
  const body = node.text.replace(new RegExp(`^${keyword}\\s+`), "").trim();
  if (!body) return [];

  const lineNumber = node.startPosition.row + 1;
  const colonIndex = body.indexOf(":");
  if (colonIndex >= 0) {
    const source = body.slice(0, colonIndex).trim();
    const specifiers = splitCommaSeparated(body.slice(colonIndex + 1)).map((entry) => {
      const aliasParts = entry.split(/\s+as\s+/i);
      return aliasParts.length > 1 ? aliasParts[1].trim() : aliasParts[0].trim();
    });

    return source ? [{ source, specifiers, lineNumber }] : [];
  }

  return splitCommaSeparated(body).map((entry) => {
    const aliasParts = entry.split(/\s+as\s+/i);
    return {
      source: aliasParts[0].trim(),
      specifiers: aliasParts.length > 1 ? [aliasParts[1].trim()] : [],
      lineNumber,
    };
  });
}

function parseExports(node: TreeSitterNode, keyword: "export" | "public"): StructuralAnalysis["exports"] {
  const body = node.text.replace(new RegExp(`^${keyword}\\s+`), "").trim();
  const lineNumber = node.startPosition.row + 1;

  return splitCommaSeparated(body).map((entry) => {
    const aliasParts = entry.split(/\s+as\s+/i);
    return {
      name: (aliasParts.length > 1 ? aliasParts[1] : aliasParts[0]).trim(),
      lineNumber,
    };
  });
}

function extractStructProperties(body: TreeSitterNode | null): string[] {
  if (!body) return [];

  const properties: string[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!child) continue;

    if (child.type === "typed_expression" || child.type === "assignment") {
      const name = extractParamName(child.namedChild(0));
      if (name) properties.push(name);
    }
  }

  return properties;
}

function extractIncludeImports(rootNode: TreeSitterNode): StructuralAnalysis["imports"] {
  const imports: StructuralAnalysis["imports"] = [];

  traverse(rootNode, (node) => {
    if (node.type !== "call_expression") return;

    const callee = childAt(node, 0);
    if (!callee || callee.text !== "include") return;

    let argsNode: TreeSitterNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === "argument_list") {
        argsNode = child;
        break;
      }
    }

    const firstArg = argsNode?.namedChild(0) ?? null;
    if (!firstArg) return;

    const isStringLike =
      firstArg.type === "string_literal" ||
      firstArg.type === "prefixed_string_literal";
    if (!isStringLike) return;

    imports.push({
      source: getStringValue(firstArg),
      specifiers: [],
      lineNumber: node.startPosition.row + 1,
    });
  });

  return imports;
}

function isDefinitionSignatureCall(node: TreeSitterNode): boolean {
  let current: TreeSitterNode | null = node;

  while (current) {
    if (current.type === "signature") return true;

    if (current.type === "assignment") {
      return current.namedChild(0) === node;
    }

    if (current.type === "function_definition") {
      return false;
    }

    current = current.parent;
  }

  return false;
}

export class JuliaExtractor implements LanguageExtractor {
  readonly languageIds = ["julia"];

  extractStructure(rootNode: TreeSitterNode): StructuralAnalysis {
    const functions: StructuralAnalysis["functions"] = [];
    const classes: StructuralAnalysis["classes"] = [];
    const imports: StructuralAnalysis["imports"] = [];
    const exports: StructuralAnalysis["exports"] = [];

    traverse(rootNode, (node) => {
      switch (node.type) {
        case "function_definition": {
          const signature = findChild(node, "signature");
          const name = extractFunctionNameFromSignature(signature);
          if (!name) break;

          functions.push({
            name,
            lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
            params: extractParamsFromSignature(signature),
            returnType: extractReturnTypeFromSignature(signature),
          });
          break;
        }

        case "assignment": {
          const shortFn = extractShortFunction(node);
          if (!shortFn) break;

          functions.push({
            name: shortFn.name,
            lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
            params: shortFn.params,
          });
          break;
        }

        case "module_definition": {
          const name = findFirstIdentifier(node.childForFieldName("name"));
          if (!name) break;

          classes.push({
            name,
            lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
            methods: [],
            properties: [],
          });
          exports.push({ name, lineNumber: node.startPosition.row + 1 });
          break;
        }

        case "struct_definition":
        case "abstract_definition":
        case "primitive_definition": {
          const typeHead = findChild(node, "type_head");
          const name = findFirstIdentifier(typeHead);
          if (!name) break;

          classes.push({
            name,
            lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
            methods: [],
            properties: node.type === "struct_definition"
              ? extractStructProperties(findChild(node, "block"))
              : [],
          });
          exports.push({ name, lineNumber: node.startPosition.row + 1 });
          break;
        }

        case "import_statement":
          imports.push(...parseImportLikeStatement(node, "import"));
          break;

        case "using_statement":
          imports.push(...parseImportLikeStatement(node, "using"));
          break;

        case "export_statement":
          exports.push(...parseExports(node, "export"));
          break;

        case "public_statement":
          exports.push(...parseExports(node, "public"));
          break;

        case "call_expression": {
          const callee = childAt(node, 0);
          if (!callee || callee.text !== "include") break;

          let argsNode: TreeSitterNode | null = null;
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child?.type === "argument_list") {
              argsNode = child;
              break;
            }
          }

          const firstArg = argsNode?.namedChild(0) ?? null;
          if (!firstArg) break;

          const isStringLike =
            firstArg.type === "string_literal" ||
            firstArg.type === "prefixed_string_literal";
          if (!isStringLike) break;

          imports.push({
            source: getStringValue(firstArg),
            specifiers: [],
            lineNumber: node.startPosition.row + 1,
          });
          break;
        }
      }
    });

    return { functions, classes, imports, exports };
  }

  extractCallGraph(rootNode: TreeSitterNode): CallGraphEntry[] {
    const entries: CallGraphEntry[] = [];
    const functionStack: string[] = [];

    const walk = (node: TreeSitterNode) => {
      let pushedName = false;

      if (node.type === "function_definition") {
        const signature = findChild(node, "signature");
        const name = extractFunctionNameFromSignature(signature);
        if (name) {
          functionStack.push(name);
          pushedName = true;
        }
      } else if (node.type === "assignment") {
        const shortFn = extractShortFunction(node);
        if (shortFn) {
          functionStack.push(shortFn.name);
          pushedName = true;
        }
      }

      if (
        node.type === "call_expression" &&
        functionStack.length > 0 &&
        !isDefinitionSignatureCall(node)
      ) {
        const callee = extractParamName(childAt(node, 0));
        if (callee) {
          entries.push({
            caller: functionStack[functionStack.length - 1],
            callee,
            lineNumber: node.startPosition.row + 1,
          });
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }

      if (pushedName) {
        functionStack.pop();
      }
    };

    walk(rootNode);

    return entries;
  }
}
