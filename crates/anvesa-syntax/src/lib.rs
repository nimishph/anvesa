pub mod facts;
pub mod outline;
pub mod topology;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
    pub doc: Option<String>,
    pub exported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeCall {
    pub name: String,
    pub line: u32,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeImport {
    pub specifier: String,
    pub kind: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeFileOutline {
    pub path: String,
    pub language: String,
    pub symbols: Vec<NativeSymbol>,
    pub calls: Vec<NativeCall>,
    pub imports: Vec<NativeImport>,
    pub has_syntax_errors: bool,
}

pub fn get_tree_sitter_language(lang: &str) -> Option<tree_sitter::Language> {
    match lang.to_lowercase().as_str() {
        "typescript" | "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "javascript" | "js" | "jsx" | "mjs" | "cjs" => {
            Some(tree_sitter_javascript::LANGUAGE.into())
        }
        "python" | "py" => Some(tree_sitter_python::LANGUAGE.into()),
        "rust" | "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        // A Vue component's script is parsed as TSX, after everything else is blanked out.
        "vue" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "css" => Some(tree_sitter_css::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "ruby" | "rb" => Some(tree_sitter_ruby::LANGUAGE.into()),
        "csharp" | "c_sharp" | "cs" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        _ => None,
    }
}

/// The language keys (as the TypeScript registry names them) that have a grammar compiled in.
pub const NATIVE_LANGUAGES: [&str; 14] = [
    "javascript",
    "typescript",
    "tsx",
    "vue",
    "css",
    "python",
    "go",
    "rust",
    "java",
    "c",
    "cpp",
    "ruby",
    "csharp",
    "php",
];

pub fn extract_file_outline(path: &str, lang_key: &str, source: &str) -> NativeFileOutline {
    let language = match get_tree_sitter_language(lang_key) {
        Some(l) => l,
        None => {
            return NativeFileOutline {
                path: path.to_string(),
                language: lang_key.to_string(),
                symbols: Vec::new(),
                calls: Vec::new(),
                imports: Vec::new(),
                has_syntax_errors: false,
            };
        }
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return NativeFileOutline {
            path: path.to_string(),
            language: lang_key.to_string(),
            symbols: Vec::new(),
            calls: Vec::new(),
            imports: Vec::new(),
            has_syntax_errors: true,
        };
    }

    let tree = match parser.parse(source.as_bytes(), None) {
        Some(t) => t,
        None => {
            return NativeFileOutline {
                path: path.to_string(),
                language: lang_key.to_string(),
                symbols: Vec::new(),
                calls: Vec::new(),
                imports: Vec::new(),
                has_syntax_errors: true,
            };
        }
    };

    let root = tree.root_node();
    let has_syntax_errors = root.has_error();
    let mut symbols = Vec::new();
    let mut calls = Vec::new();
    let mut imports = Vec::new();

    let bytes = source.as_bytes();
    walk_ast(
        root,
        bytes,
        lang_key,
        &mut symbols,
        &mut calls,
        &mut imports,
    );

    NativeFileOutline {
        path: path.to_string(),
        language: lang_key.to_string(),
        symbols,
        calls,
        imports,
        has_syntax_errors,
    }
}

pub fn parse_files_batch(files: Vec<(String, String, String)>) -> Vec<NativeFileOutline> {
    files
        .into_par_iter()
        .map(|(path, lang, src)| extract_file_outline(&path, &lang, &src))
        .collect()
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.start_byte()..node.end_byte()]).unwrap_or("")
}

fn walk_ast(
    node: Node,
    source: &[u8],
    lang: &str,
    symbols: &mut Vec<NativeSymbol>,
    calls: &mut Vec<NativeCall>,
    imports: &mut Vec<NativeImport>,
) {
    let kind = node.kind();
    let start_line = (node.start_position().row + 1) as u32;
    let end_line = (node.end_position().row + 1) as u32;

    match lang {
        "typescript" | "tsx" | "javascript" | "js" | "jsx" | "mjs" | "cjs" => match kind {
            "function_declaration" | "function" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_exported = is_ts_exported(node);
                    symbols.push(NativeSymbol {
                        name,
                        kind: "function".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_exported,
                    });
                }
            }
            "method_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    symbols.push(NativeSymbol {
                        name,
                        kind: "method".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: false,
                    });
                }
            }
            "class_declaration" | "class" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_exported = is_ts_exported(node);
                    symbols.push(NativeSymbol {
                        name,
                        kind: "class".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_exported,
                    });
                }
            }
            "interface_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_exported = is_ts_exported(node);
                    symbols.push(NativeSymbol {
                        name,
                        kind: "interface".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_exported,
                    });
                }
            }
            "type_alias_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_exported = is_ts_exported(node);
                    symbols.push(NativeSymbol {
                        name,
                        kind: "type".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_exported,
                    });
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let name = extract_call_name(fn_node, source);
                    if !name.is_empty() {
                        calls.push(NativeCall {
                            name,
                            line: start_line,
                            kind: "call".to_string(),
                        });
                    }
                }
            }
            "new_expression" => {
                if let Some(ctor_node) = node.child_by_field_name("constructor") {
                    let name = extract_call_name(ctor_node, source);
                    if !name.is_empty() {
                        calls.push(NativeCall {
                            name,
                            line: start_line,
                            kind: "new".to_string(),
                        });
                    }
                }
            }
            "import_statement" => {
                if let Some(src_node) = node.child_by_field_name("source") {
                    let raw = node_text(src_node, source);
                    let clean = raw.trim_matches(|c| c == '\'' || c == '"').to_string();
                    imports.push(NativeImport {
                        specifier: clean,
                        kind: "static".to_string(),
                        line: start_line,
                    });
                }
            }
            _ => {}
        },
        "python" | "py" => match kind {
            "function_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let exported = !name.starts_with('_');
                    symbols.push(NativeSymbol {
                        name,
                        kind: "function".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_python_docstring(node, source),
                        exported,
                    });
                }
            }
            "class_definition" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let exported = !name.starts_with('_');
                    symbols.push(NativeSymbol {
                        name,
                        kind: "class".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_python_docstring(node, source),
                        exported,
                    });
                }
            }
            "call" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let name = extract_call_name(fn_node, source);
                    if !name.is_empty() {
                        calls.push(NativeCall {
                            name,
                            line: start_line,
                            kind: "call".to_string(),
                        });
                    }
                }
            }
            "import_statement" | "import_from_statement" => {
                let text = node_text(node, source);
                imports.push(NativeImport {
                    specifier: text.to_string(),
                    kind: "static".to_string(),
                    line: start_line,
                });
            }
            _ => {}
        },
        "rust" | "rs" => match kind {
            "function_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_pub = has_child_kind(node, "visibility_modifier");
                    symbols.push(NativeSymbol {
                        name,
                        kind: "function".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_pub,
                    });
                }
            }
            "struct_item" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let is_pub = has_child_kind(node, "visibility_modifier");
                    symbols.push(NativeSymbol {
                        name,
                        kind: "class".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported: is_pub,
                    });
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let name = extract_call_name(fn_node, source);
                    if !name.is_empty() {
                        calls.push(NativeCall {
                            name,
                            line: start_line,
                            kind: "call".to_string(),
                        });
                    }
                }
            }
            _ => {}
        },
        "go" => match kind {
            "function_declaration" | "method_declaration" => {
                if let Some(name_node) = node.child_by_field_name("name") {
                    let name = node_text(name_node, source).to_string();
                    let exported = name.chars().next().map_or(false, |c| c.is_uppercase());
                    symbols.push(NativeSymbol {
                        name,
                        kind: "function".to_string(),
                        start_line,
                        end_line,
                        signature: None,
                        doc: extract_preceding_doc(node, source),
                        exported,
                    });
                }
            }
            "type_declaration" => {
                if let Some(spec) = node.child(1) {
                    if let Some(name_node) = spec.child_by_field_name("name") {
                        let name = node_text(name_node, source).to_string();
                        let exported = name.chars().next().map_or(false, |c| c.is_uppercase());
                        symbols.push(NativeSymbol {
                            name,
                            kind: "type".to_string(),
                            start_line,
                            end_line,
                            signature: None,
                            doc: extract_preceding_doc(node, source),
                            exported,
                        });
                    }
                }
            }
            "call_expression" => {
                if let Some(fn_node) = node.child_by_field_name("function") {
                    let name = extract_call_name(fn_node, source);
                    if !name.is_empty() {
                        calls.push(NativeCall {
                            name,
                            line: start_line,
                            kind: "call".to_string(),
                        });
                    }
                }
            }
            _ => {}
        },
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_ast(child, source, lang, symbols, calls, imports);
    }
}

fn has_child_kind(node: Node, kind_name: &str) -> bool {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == kind_name {
            return true;
        }
    }
    false
}

fn is_ts_exported(node: Node) -> bool {
    if let Some(parent) = node.parent() {
        if parent.kind() == "export_statement" {
            return true;
        }
    }
    has_child_kind(node, "export")
}

fn extract_call_name(fn_node: Node, source: &[u8]) -> String {
    match fn_node.kind() {
        "identifier" => node_text(fn_node, source).to_string(),
        "member_expression" | "field_expression" | "selector_expression" => {
            if let Some(prop) = fn_node
                .child_by_field_name("property")
                .or_else(|| fn_node.child_by_field_name("field"))
            {
                node_text(prop, source).to_string()
            } else {
                node_text(fn_node, source).to_string()
            }
        }
        _ => node_text(fn_node, source).to_string(),
    }
}

fn extract_preceding_doc(node: Node, source: &[u8]) -> Option<String> {
    let check_node = if let Some(parent) = node.parent() {
        if parent.kind() == "export_statement" {
            parent
        } else {
            node
        }
    } else {
        node
    };

    if let Some(prev) = check_node.prev_sibling() {
        if prev.kind() == "comment" {
            let text = node_text(prev, source).trim();
            if text.starts_with("/**") || text.starts_with("///") || text.starts_with("//") {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn extract_python_docstring(node: Node, source: &[u8]) -> Option<String> {
    if let Some(body) = node.child_by_field_name("body") {
        let mut cursor = body.walk();
        for child in body.children(&mut cursor) {
            if child.kind() == "expression_statement" {
                if let Some(expr) = child.child(0) {
                    if expr.kind() == "string" {
                        let text = node_text(expr, source).trim_matches('"').trim_matches('\'');
                        return Some(text.trim().to_string());
                    }
                }
            }
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_typescript_outline() {
        let code = r#"
import { foo } from './bar';

/** Parse the config */
export function parseConfig(path: string): Config {
    return load(path);
}

export class Worker {
    run() {
        this.process();
    }
}
"#;
        let outline = extract_file_outline("src/test.ts", "typescript", code);
        assert_eq!(outline.language, "typescript");
        assert!(!outline.has_syntax_errors);
        assert_eq!(outline.imports.len(), 1);
        assert_eq!(outline.imports[0].specifier, "./bar");

        assert_eq!(outline.symbols.len(), 3); // parseConfig, Worker, run
        assert_eq!(outline.symbols[0].name, "parseConfig");
        assert_eq!(outline.symbols[0].kind, "function");
        assert!(outline.symbols[0].exported);
        assert!(outline.symbols[0].doc.is_some());

        assert_eq!(outline.symbols[1].name, "Worker");
        assert_eq!(outline.symbols[1].kind, "class");
        assert!(outline.symbols[1].exported);

        assert_eq!(outline.symbols[2].name, "run");
        assert_eq!(outline.symbols[2].kind, "method");
    }

    #[test]
    fn test_extract_python_outline() {
        let code = r#"
import os

def calculate(a, b):
    """Computes sum"""
    return a + b

class MathEngine:
    def add(self):
        calculate(1, 2)
"#;
        let outline = extract_file_outline("math.py", "python", code);
        assert!(!outline.has_syntax_errors);
        assert_eq!(outline.symbols.len(), 3);
        assert_eq!(outline.symbols[0].name, "calculate");
        assert_eq!(outline.symbols[0].doc.as_deref(), Some("Computes sum"));
        assert_eq!(outline.symbols[1].name, "MathEngine");
        assert_eq!(outline.symbols[2].name, "add");
    }

    #[test]
    fn test_parse_files_batch_parallel() {
        let f1 = (
            "a.ts".to_string(),
            "typescript".to_string(),
            "export function a() {}".to_string(),
        );
        let f2 = (
            "b.py".to_string(),
            "python".to_string(),
            "def b(): pass".to_string(),
        );
        let f3 = (
            "c.rs".to_string(),
            "rust".to_string(),
            "pub fn c() {}".to_string(),
        );

        let results = parse_files_batch(vec![f1, f2, f3]);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].symbols[0].name, "a");
        assert_eq!(results[1].symbols[0].name, "b");
        assert_eq!(results[2].symbols[0].name, "c");
    }
}

/// One file to encode: its path, language key and text.
pub struct OutlineInput {
    pub path: String,
    pub language: String,
    pub source: String,
}

/// Encode many files at once on every core. Each language's mapping is looked up by key; a file
/// whose language has no mapping or no compiled grammar comes back as `None`.
pub fn encode_files_batch(
    files: &[OutlineInput],
    mappings: &std::collections::HashMap<String, outline::LanguageMapping>,
    options: &outline::EncodeOptions,
) -> Vec<Option<outline::EncodedFile>> {
    files
        .par_iter()
        .map(|file| {
            let mapping = mappings.get(&file.language)?;
            let options = outline::EncodeOptions {
                path: Some(file.path.clone()),
                ..options.clone()
            };
            outline::encode_source(&file.source, &file.language, mapping, &options)
        })
        .collect()
}
