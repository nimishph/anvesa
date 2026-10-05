//! What indexing learns about one file, from the same single parse as its outline: symbols with
//! ids and parents, calls attributed to the symbol around them, imports and exports, and PHP's
//! declared types.
//!
//! A port of `indexer/src/extract/` (extract, calls, callee-syntax, callee, imports, php-types,
//! scope). Positions are UTF-16 offsets, as on the TypeScript side, so spans and calls line up the
//! same way.

use crate::outline::{
    encode_tree, outline_symbols, CompiledMapping, EncodeOptions, EncodeStats, LanguageMapping,
    OutlineSymbol, TypeBinding, TypeRules, WNode,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

// --- the facts -------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolFact {
    pub id: String,
    pub path: String,
    pub name: String,
    pub base_name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exported: Option<bool>,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
}

/// What a call is made on, when the source says.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Receiver {
    #[serde(rename = "self")]
    SelfRef,
    Name {
        name: String,
    },
    Result {
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        receiver: Option<Box<Receiver>>,
    },
    Complex,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallFact {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<Receiver>,
    pub kind: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportBinding {
    pub imported: String,
    pub local: String,
    pub type_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportFact {
    pub specifier: String,
    pub kind: String,
    pub relative: bool,
    pub type_only: bool,
    pub bindings: Vec<ImportBinding>,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFact {
    pub name: String,
    pub local: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeFact {
    pub scope: String,
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionGaps {
    pub unnamed_calls: u32,
    pub computed_imports: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    pub path: String,
    pub language: String,
    pub symbols: Vec<SymbolFact>,
    pub calls: Vec<CallFact>,
    pub imports: Vec<ImportFact>,
    pub exports: Vec<ExportFact>,
    pub has_syntax_errors: bool,
    pub imports_supported: bool,
    pub gaps: ExtractionGaps,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub types: Option<Vec<TypeFact>>,
}

/// The outline and the facts of one file, from one parse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedFile {
    pub root: WNode,
    pub stats: EncodeStats,
    pub facts: FileFacts,
}

// --- extraction ------------------------------------------------------------------------------------

/// Parse once, encode with docs and positions, and read facts from the same tree. `None` when no
/// grammar for `language` is compiled in.
pub fn extract_file(
    path: &str,
    language: &str,
    source: &str,
    mapping: &LanguageMapping,
) -> Option<ExtractedFile> {
    let grammar = crate::get_tree_sitter_language(language)?;
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;
    let tree = parser.parse(source, None)?;
    let compiled = CompiledMapping::new(mapping);
    let options = EncodeOptions {
        path: Some(path.to_string()),
        docs: true,
        positions: true,
        max_depth: None,
    };
    let (root, stats) = encode_tree(tree.root_node(), source, &compiled, &options);
    let utf16 = utf16_offsets(source);
    let placed = place_symbols(path, outline_symbols(&root));

    let mut scope = NestingCursor::new(&placed);
    let mut calls = CallCollector::default();
    let mut imports = ImportCollector::for_language(language);
    let mut types = mapping.type_rules.as_ref().map(TypeCollector::new);

    // Every named node, parents before children, siblings in source order.
    let mut pending = vec![tree.root_node()];
    while let Some(node) = pending.pop() {
        let at = utf16[node.start_byte()];
        calls.visit(node, source, at, &mut scope);
        if let Some(imports) = imports.as_mut() {
            imports.visit(node, source);
        }
        if let Some(types) = types.as_mut() {
            types.visit(node, source, at, &mut scope);
        }
        let mut cursor = node.walk();
        let children: Vec<Node> = node.named_children(&mut cursor).collect();
        pending.extend(children.into_iter().rev());
    }

    let (import_facts, export_facts, computed) = match imports {
        Some(collector) => (collector.imports, collector.exports, collector.computed),
        None => (Vec::new(), Vec::new(), 0),
    };
    let listed: HashSet<&str> = export_facts.iter().map(|e| e.local.as_str()).collect();
    let symbols = symbol_facts(path, &placed)
        .into_iter()
        .map(|mut symbol| {
            if symbol.parent_id.is_none()
                && symbol.exported == Some(false)
                && listed.contains(symbol.base_name.as_str())
            {
                symbol.exported = Some(true);
            }
            symbol
        })
        .collect();
    let type_facts = types
        .map(|collector| collector.types)
        .filter(|t| !t.is_empty());

    let facts = FileFacts {
        path: path.to_string(),
        language: language.to_string(),
        symbols,
        calls: calls.calls,
        imports: import_facts,
        exports: export_facts,
        has_syntax_errors: tree.root_node().has_error(),
        imports_supported: ImportCollector::supports(language),
        gaps: ExtractionGaps {
            unnamed_calls: calls.unnamed,
            computed_imports: computed,
        },
        types: type_facts,
    };
    Some(ExtractedFile { root, stats, facts })
}

fn utf16_offsets(source: &str) -> Vec<u32> {
    let mut table = vec![0u32; source.len() + 1];
    let mut units = 0u32;
    for (index, ch) in source.char_indices() {
        for byte in 0..ch.len_utf8() {
            table[index + byte] = units;
        }
        units += ch.len_utf16() as u32;
    }
    table[source.len()] = units;
    table
}

fn text<'s>(node: Node, source: &'s str) -> &'s str {
    &source[node.start_byte()..node.end_byte()]
}

fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn line_of(node: Node) -> u32 {
    node.start_position().row as u32 + 1
}

// --- symbols and their spans -----------------------------------------------------------------------

struct Placed {
    symbol: OutlineSymbol,
    start: u32,
    end: u32,
    id: String,
}

/// Give each symbol its span and a file-unique id, then order them for `NestingCursor`.
fn place_symbols(path: &str, symbols: Vec<OutlineSymbol>) -> Vec<Placed> {
    let mut seen: HashMap<String, u32> = HashMap::new();
    let mut placed: Vec<Placed> = symbols
        .into_iter()
        .map(|symbol| {
            let count = seen.entry(symbol.name.clone()).or_insert(0);
            *count += 1;
            let base = format!("{path}#{}", symbol.name);
            let id = if *count == 1 {
                base
            } else {
                format!("{base}~{count}")
            };
            Placed {
                start: symbol.start_index.unwrap_or(0),
                end: symbol.end_index.unwrap_or(0),
                symbol,
                id,
            }
        })
        .collect();
    // By start; where two start together, the longer first. Stable, as JavaScript's sort is.
    placed.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    placed
}

/// Which span is innermost around a position, for positions that never go backwards.
struct NestingCursor<'p> {
    spans: &'p [Placed],
    open: Vec<usize>,
    next: usize,
}

impl<'p> NestingCursor<'p> {
    fn new(spans: &'p [Placed]) -> Self {
        NestingCursor {
            spans,
            open: Vec::new(),
            next: 0,
        }
    }
    fn at(&mut self, position: u32) -> Option<&'p str> {
        while self.next < self.spans.len() {
            let candidate = &self.spans[self.next];
            if candidate.start > position {
                break;
            }
            let index = self.next;
            self.next += 1;
            self.close_before(candidate.start);
            if candidate.end > position {
                self.open.push(index);
            }
        }
        self.close_before(position);
        self.open.last().map(|&index| self.spans[index].id.as_str())
    }
    fn close_before(&mut self, position: u32) {
        while let Some(&last) = self.open.last() {
            if self.spans[last].end <= position {
                self.open.pop();
            } else {
                break;
            }
        }
    }
}

fn symbol_facts(path: &str, placed: &[Placed]) -> Vec<SymbolFact> {
    let mut facts = Vec::with_capacity(placed.len());
    let mut open: Vec<usize> = Vec::new();
    for (index, current) in placed.iter().enumerate() {
        while let Some(&last) = open.last() {
            if placed[last].end <= current.start {
                open.pop();
            } else {
                break;
            }
        }
        let symbol = &current.symbol;
        facts.push(SymbolFact {
            id: current.id.clone(),
            path: path.to_string(),
            name: symbol.name.clone(),
            base_name: symbol.base_name.clone(),
            kind: symbol.kind.clone(),
            parent_id: open.last().map(|&parent| placed[parent].id.clone()),
            exported: symbol.exported,
            start_line: symbol.line,
            end_line: symbol.end_line,
            signature: symbol.signature.clone(),
            params: symbol.params.clone(),
            doc: symbol.doc.clone(),
            alias_of: symbol.alias_of.clone(),
        });
        open.push(index);
    }
    facts
}

// --- calls -----------------------------------------------------------------------------------------

struct CallShape {
    kind: &'static str,
    callee: Option<&'static str>,
    receiver: Option<&'static str>,
    name: Option<&'static str>,
    joiner: &'static str,
}

const fn shape(
    kind: &'static str,
    callee: Option<&'static str>,
    receiver: Option<&'static str>,
    name: Option<&'static str>,
    joiner: &'static str,
) -> CallShape {
    CallShape {
        kind,
        callee,
        receiver,
        name,
        joiner,
    }
}

fn call_shape(kind: &str) -> Option<CallShape> {
    Some(match kind {
        "call_expression" => shape("call", Some("function"), None, None, "."),
        "call" => shape(
            "call",
            Some("function"),
            Some("receiver"),
            Some("method"),
            ".",
        ),
        "new_expression" => shape("new", Some("constructor"), None, None, "."),
        "function_call_expression" => shape("call", Some("function"), None, None, "."),
        "invocation_expression" => shape("call", Some("function"), None, None, "."),
        "method_invocation" => shape("call", None, Some("object"), Some("name"), "."),
        "member_call_expression" => shape("call", None, Some("object"), Some("name"), "."),
        "scoped_call_expression" => shape("call", None, Some("scope"), Some("name"), "::"),
        "object_creation_expression" => shape("new", Some("type"), None, None, "."),
        "jsx_self_closing_element" => shape("jsx", Some("name"), None, None, "."),
        "jsx_opening_element" => shape("jsx", Some("name"), None, None, "."),
        _ => return None,
    })
}

/// A callee read into its name and what it is called on.
struct Callee {
    name: Option<String>,
    receiver: Option<Receiver>,
}

#[derive(Default)]
struct CallCollector {
    calls: Vec<CallFact>,
    unnamed: u32,
}

impl CallCollector {
    fn visit(&mut self, node: Node, source: &str, at: u32, scope: &mut NestingCursor) {
        let Some(shape) = call_shape(node.kind()) else {
            // The scope cursor must still see every position, in order.
            scope.at(at);
            return;
        };
        let from = scope.at(at).map(str::to_string);
        let Some(callee) = callee_of(node, &shape, source) else {
            return;
        };
        let Some(name) = callee.name else {
            if shape.kind != "jsx" {
                self.unnamed += 1;
            }
            return;
        };
        if shape.kind == "jsx" && !is_component(&name, callee.receiver.is_some()) {
            return;
        }
        if callee.receiver.is_none() && matches!(name.as_str(), "super" | "import" | "require") {
            return;
        }
        self.calls.push(CallFact {
            from,
            name,
            receiver: callee.receiver,
            kind: shape.kind.to_string(),
            line: line_of(node),
        });
    }
}

fn callee_of(node: Node, shape: &CallShape, source: &str) -> Option<Callee> {
    if let Some(chained) = callee_of_chained(node, shape, source) {
        return Some(chained);
    }
    if let (Some(field_name), None) = (shape.callee, shape.receiver) {
        if let Some(field) = node.child_by_field_name(field_name) {
            if let Some(read) = callee_from_syntax(field, source) {
                return Some(read);
            }
        }
    }
    callee_text(node, shape, source).map(|text| parse_callee(&text))
}

fn callee_of_chained(node: Node, shape: &CallShape, source: &str) -> Option<Callee> {
    let (receiver_field, name_field) = (shape.receiver?, shape.name?);
    let owner = node.child_by_field_name(receiver_field)?;
    let name = node.child_by_field_name(name_field)?;
    let inner = call_shape(owner.kind())?;
    if inner.kind != "call" {
        return None;
    }
    let called = callee_of(owner, &inner, source)?;
    let called_name = called.name?;
    Some(Callee {
        name: Some(text(name, source).to_string()),
        receiver: Some(Receiver::Result {
            name: called_name,
            receiver: called.receiver.map(Box::new),
        }),
    })
}

fn callee_text(node: Node, shape: &CallShape, source: &str) -> Option<String> {
    if let (Some(receiver_field), Some(name_field)) = (shape.receiver, shape.name) {
        let owner = node.child_by_field_name(receiver_field);
        let name = node.child_by_field_name(name_field);
        if let (Some(owner), Some(name)) = (owner, name) {
            return Some(format!(
                "{}{}{}",
                text(owner, source),
                shape.joiner,
                text(name, source)
            ));
        }
        if let (Some(name), None) = (name, shape.callee) {
            return Some(text(name, source).to_string());
        }
    }
    if let Some(field) = shape.callee {
        if let Some(callee) = node.child_by_field_name(field) {
            return Some(text(callee, source).to_string());
        }
    }
    if shape.kind == "new" {
        return named_children(node)
            .into_iter()
            .find(|child| child.kind() == "name" || child.kind() == "qualified_name")
            .map(|child| text(child, source).to_string());
    }
    None
}

fn is_component(name: &str, has_receiver: bool) -> bool {
    if has_receiver {
        return true;
    }
    // Capitalised, by JavaScript's measure: the first UTF-16 unit is not its own lower case.
    match name.chars().next() {
        Some(first) => first.to_lowercase().next() != Some(first),
        None => false,
    }
}

// --- callees, from syntax --------------------------------------------------------------------------

const TRANSPARENT: [&str; 5] = [
    "await_expression",
    "parenthesized_expression",
    "non_null_expression",
    "as_expression",
    "satisfies_expression",
];
const NAME_NODES: [&str; 4] = [
    "identifier",
    "property_identifier",
    "private_property_identifier",
    "type_identifier",
];

fn unwrap(node: Node) -> Node {
    let mut current = node;
    while TRANSPARENT.contains(&current.kind()) {
        match current.named_child(0) {
            Some(inner) => current = inner,
            None => break,
        }
    }
    current
}

fn member_property(node: Node) -> Option<Node> {
    node.child_by_field_name(if node.kind() == "attribute" {
        "attribute"
    } else {
        "property"
    })
}

/// What is called, read from the callee's syntax; `None` for a node this does not know.
fn callee_from_syntax(node: Node, source: &str) -> Option<Callee> {
    let callee = unwrap(node);
    let kind = callee.kind();
    let nothing = || Callee {
        name: None,
        receiver: None,
    };
    if NAME_NODES.contains(&kind) {
        return Some(Callee {
            name: Some(text(callee, source).to_string()),
            receiver: None,
        });
    }
    if kind == "this" || kind == "super" {
        return Some(nothing());
    }
    if kind == "member_expression" || kind == "attribute" {
        let property = member_property(callee);
        let object = callee.child_by_field_name("object");
        let (Some(property), Some(object)) = (property, object) else {
            return None;
        };
        if !NAME_NODES.contains(&property.kind()) {
            return Some(nothing());
        }
        return Some(Callee {
            name: Some(text(property, source).to_string()),
            receiver: Some(receiver_of(object, source)),
        });
    }
    if matches!(
        kind,
        "subscript_expression"
            | "subscript"
            | "call_expression"
            | "call"
            | "function_expression"
            | "arrow_function"
            | "lambda"
    ) {
        return Some(nothing());
    }
    None
}

fn receiver_of(node: Node, source: &str) -> Receiver {
    let object = unwrap(node);
    match object.kind() {
        "this" | "super" => Receiver::SelfRef,
        "identifier" => {
            let name = text(object, source);
            if matches!(name, "this" | "self" | "cls") {
                Receiver::SelfRef
            } else {
                Receiver::Name {
                    name: name.to_string(),
                }
            }
        }
        "member_expression" | "attribute" => match dotted_name(object, source) {
            Some(name) => Receiver::Name { name },
            None => Receiver::Complex,
        },
        _ => Receiver::Complex,
    }
}

fn dotted_name(node: Node, source: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    let mut current = Some(unwrap(node));
    while let Some(node) = current {
        if node.kind() != "member_expression" && node.kind() != "attribute" {
            break;
        }
        let property = member_property(node)?;
        if !NAME_NODES.contains(&property.kind()) {
            return None;
        }
        parts.insert(0, text(property, source));
        current = node.child_by_field_name("object").map(unwrap);
    }
    let current = current?;
    match current.kind() {
        "this" => parts.insert(0, "this"),
        "identifier" => parts.insert(0, text(current, source)),
        _ => return None,
    }
    Some(parts.join("."))
}

// --- callees, from text ----------------------------------------------------------------------------

const SEPARATORS: [&str; 5] = ["?.", "->", "::", ".", "\\"];

/// Break a callee's text into name and receiver, whatever the language's notation.
fn parse_callee(text: &str) -> Callee {
    let segments = split_chain(text.trim());
    let Some(last) = segments.last() else {
        return Callee {
            name: None,
            receiver: None,
        };
    };
    let Some(name) = plain_name(last) else {
        return Callee {
            name: None,
            receiver: None,
        };
    };
    if segments.len() == 1 {
        return Callee {
            name: Some(name),
            receiver: None,
        };
    }
    let owners: Vec<Option<String>> = segments[..segments.len() - 1]
        .iter()
        .map(|segment| plain_name(segment))
        .collect();
    if owners.iter().any(Option::is_none) {
        return Callee {
            name: Some(name),
            receiver: Some(Receiver::Complex),
        };
    }
    let owners: Vec<String> = owners.into_iter().flatten().collect();
    let chain = owners.join(".");
    if owners.len() == 1
        && matches!(
            chain.as_str(),
            "this" | "self" | "cls" | "super" | "parent" | "static" | "$this"
        )
    {
        return Callee {
            name: Some(name),
            receiver: Some(Receiver::SelfRef),
        };
    }
    Callee {
        name: Some(name),
        receiver: Some(Receiver::Name { name: chain }),
    }
}

fn split_chain(text: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut expected: Vec<char> = Vec::new();
    let mut start = 0usize;
    let mut index = 0usize;
    let bytes = text.as_bytes();
    while index < text.len() {
        let ch = text[index..]
            .chars()
            .next()
            .expect("index is on a char boundary");
        let closer = match ch {
            '(' => Some(')'),
            '[' => Some(']'),
            '{' => Some('}'),
            '<' => Some('>'),
            _ => None,
        };
        if let Some(closer) = closer {
            expected.push(closer);
            index += ch.len_utf8();
            continue;
        }
        if matches!(ch, ')' | ']' | '}' | '>') {
            if expected.last() == Some(&ch) {
                expected.pop();
            }
            index += ch.len_utf8();
            continue;
        }
        if expected.is_empty() {
            if let Some(separator) = SEPARATORS
                .iter()
                .find(|candidate| bytes[index..].starts_with(candidate.as_bytes()))
            {
                segments.push(text[start..index].to_string());
                index += separator.len();
                start = index;
                continue;
            }
        }
        index += ch.len_utf8();
    }
    segments.push(text[start..].to_string());
    segments
}

/// JavaScript's `/^[\p{L}_$][\p{L}\p{N}_$]*$/u`.
fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.is_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_alphabetic() || ch.is_numeric() || ch == '_' || ch == '$')
}

fn plain_name(segment: &str) -> Option<String> {
    let mut text = segment.trim();
    if let Some(generic) = text.find('<') {
        if generic > 0 && text.ends_with('>') {
            text = &text[..generic];
        }
    }
    let text = text.trim_end_matches(['?', '!']);
    is_identifier(text).then(|| text.to_string())
}

// --- imports ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    EcmaScript,
    Python,
    Php,
}

struct ImportCollector {
    family: Family,
    imports: Vec<ImportFact>,
    exports: Vec<ExportFact>,
    computed: u32,
}

fn has_token(node: Node, token: &str) -> bool {
    let mut cursor = node.walk();
    let found = node
        .children(&mut cursor)
        .any(|child| !child.is_named() && child.kind() == token);
    found
}

/// The value of a string literal with nothing computed in it.
fn literal_string(node: Option<Node>, source: &str) -> Option<String> {
    let node = node?;
    if node.kind() != "string" && node.kind() != "template_string" {
        return None;
    }
    let children = named_children(node);
    if children
        .iter()
        .any(|child| child.kind() == "template_substitution")
    {
        return None;
    }
    Some(
        children
            .iter()
            .filter(|child| child.kind() == "string_fragment" || child.kind() == "escape_sequence")
            .map(|child| text(*child, source))
            .collect(),
    )
}

fn binding(imported: &str, local: &str, type_only: bool) -> ImportBinding {
    ImportBinding {
        imported: imported.to_string(),
        local: local.to_string(),
        type_only,
    }
}

impl ImportCollector {
    fn supports(language: &str) -> bool {
        Self::family_of(language).is_some()
    }

    fn family_of(language: &str) -> Option<Family> {
        match language {
            "javascript" | "typescript" | "tsx" | "vue" => Some(Family::EcmaScript),
            "python" => Some(Family::Python),
            "php" => Some(Family::Php),
            _ => None,
        }
    }

    fn for_language(language: &str) -> Option<Self> {
        Self::family_of(language).map(|family| ImportCollector {
            family,
            imports: Vec::new(),
            exports: Vec::new(),
            computed: 0,
        })
    }

    fn add(
        &mut self,
        node: Node,
        specifier: String,
        kind: &str,
        bindings: Vec<ImportBinding>,
        type_only: bool,
    ) {
        self.imports.push(ImportFact {
            relative: specifier.starts_with('.'),
            specifier,
            kind: kind.to_string(),
            type_only,
            bindings,
            line: line_of(node),
        });
    }

    fn visit(&mut self, node: Node, source: &str) {
        match (self.family, node.kind()) {
            (Family::EcmaScript, "import_statement") => self.es_import(node, source),
            (Family::EcmaScript, "export_statement") => self.es_export(node, source),
            (Family::EcmaScript, "call_expression") => self.es_load_call(node, source),
            (Family::Python, "import_statement") => self.py_import(node, source),
            (Family::Python, "import_from_statement") => self.py_from(node, source),
            (Family::Php, "namespace_use_declaration") => self.php_use(node, source),
            _ => {}
        }
    }

    fn es_import(&mut self, node: Node, source: &str) {
        let type_only = has_token(node, "type");
        let children = named_children(node);
        if let Some(clause) = children
            .iter()
            .find(|child| child.kind() == "import_require_clause")
        {
            let specifier = literal_string(clause.child_by_field_name("source"), source);
            let local = named_children(*clause)
                .into_iter()
                .find(|child| child.kind() == "identifier");
            match (specifier, local) {
                (Some(specifier), Some(local)) => self.add(
                    node,
                    specifier,
                    "require",
                    vec![binding("*", text(local, source), type_only)],
                    type_only,
                ),
                _ => self.computed += 1,
            }
            return;
        }
        let Some(specifier) = literal_string(node.child_by_field_name("source"), source) else {
            return;
        };
        match children
            .iter()
            .find(|child| child.kind() == "import_clause")
        {
            None => self.add(node, specifier, "side-effect", Vec::new(), false),
            Some(clause) => {
                let bindings = import_clause_bindings(*clause, type_only, source);
                self.add(node, specifier, "static", bindings, type_only);
            }
        }
    }

    fn es_export(&mut self, node: Node, source: &str) {
        let Some(source_node) = node.child_by_field_name("source") else {
            self.es_export_local(node, source);
            return;
        };
        let Some(specifier) = literal_string(Some(source_node), source) else {
            return;
        };
        let type_only = has_token(node, "type");
        let mut bindings = Vec::new();
        for child in named_children(node) {
            if child.kind() == "namespace_export" {
                let alias = named_children(child)
                    .into_iter()
                    .find(|part| part.kind() == "identifier");
                let local = alias.map(|a| text(a, source)).unwrap_or("*");
                bindings.push(binding("*", local, type_only));
            } else if child.kind() == "export_clause" {
                for part in named_children(child) {
                    if part.kind() != "export_specifier" {
                        continue;
                    }
                    let Some(name) = part.child_by_field_name("name").map(|n| text(n, source))
                    else {
                        continue;
                    };
                    let alias = part.child_by_field_name("alias").map(|n| text(n, source));
                    bindings.push(binding(
                        name,
                        alias.unwrap_or(name),
                        type_only || has_token(part, "type"),
                    ));
                }
            }
        }
        if bindings.is_empty() && has_token(node, "*") {
            bindings.push(binding("*", "*", type_only));
        }
        self.add(node, specifier, "reexport", bindings, type_only);
    }

    fn es_export_local(&mut self, node: Node, source: &str) {
        let line = line_of(node);
        for child in named_children(node) {
            if child.kind() != "export_clause" {
                continue;
            }
            for part in named_children(child) {
                if part.kind() != "export_specifier" {
                    continue;
                }
                let Some(local) = part.child_by_field_name("name").map(|n| text(n, source)) else {
                    continue;
                };
                let alias = part.child_by_field_name("alias").map(|n| text(n, source));
                self.exports.push(ExportFact {
                    name: alias.unwrap_or(local).to_string(),
                    local: local.to_string(),
                    line,
                });
            }
        }
        if let Some(value) = node.child_by_field_name("value") {
            if value.kind() == "identifier" && has_token(node, "default") {
                self.exports.push(ExportFact {
                    name: "default".to_string(),
                    local: text(value, source).to_string(),
                    line,
                });
            }
        }
    }

    fn es_load_call(&mut self, node: Node, source: &str) {
        let Some(callee) = node.child_by_field_name("function") else {
            return;
        };
        let kind = if callee.kind() == "import" {
            "dynamic"
        } else if text(callee, source) == "require" {
            "require"
        } else {
            return;
        };
        let argument = node
            .child_by_field_name("arguments")
            .and_then(|arguments| arguments.named_child(0));
        let Some(specifier) = literal_string(argument, source) else {
            self.computed += 1;
            return;
        };
        let bindings = loaded_bindings(node, source);
        self.add(node, specifier, kind, bindings, false);
    }

    fn py_import(&mut self, node: Node, source: &str) {
        let mut cursor = node.walk();
        let names: Vec<Node> = node.children_by_field_name("name", &mut cursor).collect();
        for child in names {
            if child.kind() == "aliased_import" {
                let Some(module) = child.child_by_field_name("name").map(|n| text(n, source))
                else {
                    continue;
                };
                let alias = child.child_by_field_name("alias").map(|n| text(n, source));
                self.add(
                    node,
                    module.to_string(),
                    "static",
                    vec![binding("*", alias.unwrap_or(module), false)],
                    false,
                );
            } else if child.kind() == "dotted_name" {
                let whole = text(child, source);
                let local = whole.split('.').next().unwrap_or(whole);
                self.add(
                    node,
                    whole.to_string(),
                    "static",
                    vec![binding("*", local, false)],
                    false,
                );
            }
        }
    }

    fn py_from(&mut self, node: Node, source: &str) {
        let Some(module) = node
            .child_by_field_name("module_name")
            .map(|n| text(n, source))
        else {
            return;
        };
        let mut bindings = Vec::new();
        let mut cursor = node.walk();
        let names: Vec<Node> = node.children_by_field_name("name", &mut cursor).collect();
        for child in names {
            if child.kind() == "aliased_import" {
                if let Some(name) = child.child_by_field_name("name").map(|n| text(n, source)) {
                    let alias = child.child_by_field_name("alias").map(|n| text(n, source));
                    bindings.push(binding(name, alias.unwrap_or(name), false));
                }
            } else if child.kind() == "dotted_name" {
                let name = text(child, source);
                bindings.push(binding(name, name, false));
            }
        }
        if named_children(node)
            .iter()
            .any(|child| child.kind() == "wildcard_import")
        {
            bindings.push(binding("*", "*", false));
        }
        self.add(node, module.to_string(), "static", bindings, false);
    }

    fn php_use(&mut self, node: Node, source: &str) {
        let children = named_children(node);
        let prefix = children
            .iter()
            .find(|c| c.kind() == "namespace_name")
            .map(|n| text(*n, source).trim_start_matches('\\').to_string())
            .unwrap_or_default();
        let group = children.iter().find(|c| c.kind() == "namespace_use_group");
        let clauses: Vec<Node> = match group {
            Some(group) => named_children(*group),
            None => children.clone(),
        }
        .into_iter()
        .filter(|c| c.kind() == "namespace_use_clause")
        .collect();
        for clause in clauses {
            let parts: Vec<Node> = named_children(clause)
                .into_iter()
                .filter(|c| c.kind() == "qualified_name" || c.kind() == "name")
                .collect();
            let Some(first) = parts.first() else { continue };
            let target = text(*first, source).trim_start_matches('\\');
            let full = if prefix.is_empty() {
                target.to_string()
            } else {
                format!("{prefix}\\{target}")
            };
            let imported = full.rsplit('\\').next().unwrap_or(&full).to_string();
            let local = parts
                .get(1)
                .map(|n| text(*n, source).to_string())
                .unwrap_or_else(|| imported.clone());
            self.add(
                node,
                full.clone(),
                "static",
                vec![binding(&imported, &local, false)],
                false,
            );
        }
    }
}

fn import_clause_bindings(clause: Node, type_only: bool, source: &str) -> Vec<ImportBinding> {
    let mut bindings = Vec::new();
    for child in named_children(clause) {
        match child.kind() {
            "identifier" => bindings.push(binding("default", text(child, source), type_only)),
            "namespace_import" => {
                if let Some(local) = named_children(child)
                    .into_iter()
                    .find(|part| part.kind() == "identifier")
                {
                    bindings.push(binding("*", text(local, source), type_only));
                }
            }
            "named_imports" => {
                for specifier in named_children(child) {
                    if specifier.kind() != "import_specifier" {
                        continue;
                    }
                    let Some(name) = specifier
                        .child_by_field_name("name")
                        .map(|n| text(n, source))
                    else {
                        continue;
                    };
                    let alias = specifier
                        .child_by_field_name("alias")
                        .map(|n| text(n, source));
                    bindings.push(binding(
                        name,
                        alias.unwrap_or(name),
                        type_only || has_token(specifier, "type"),
                    ));
                }
            }
            _ => {}
        }
    }
    bindings
}

/// What `const ... = require('x')` or `= await import('x')` binds.
fn loaded_bindings(call: Node, source: &str) -> Vec<ImportBinding> {
    let mut holder = call.parent();
    while let Some(node) = holder {
        if node.kind() == "await_expression" || node.kind() == "parenthesized_expression" {
            holder = node.parent();
        } else {
            break;
        }
    }
    let Some(holder) = holder.filter(|h| h.kind() == "variable_declarator") else {
        return Vec::new();
    };
    let Some(target) = holder.child_by_field_name("name") else {
        return Vec::new();
    };
    if target.kind() == "identifier" {
        return vec![binding("*", text(target, source), false)];
    }
    if target.kind() != "object_pattern" {
        return Vec::new();
    }
    let mut bindings = Vec::new();
    for part in named_children(target) {
        if part.kind() == "shorthand_property_identifier_pattern" {
            let name = text(part, source);
            bindings.push(binding(name, name, false));
        } else if part.kind() == "pair_pattern" {
            let key = part.child_by_field_name("key").map(|n| text(n, source));
            let value = part.child_by_field_name("value");
            if let (Some(key), Some(value)) = (key, value) {
                if value.kind() == "identifier" {
                    bindings.push(binding(key, text(value, source), false));
                }
            }
        }
    }
    bindings
}

// --- declared types --------------------------------------------------------------------------------

/// Reads declared types as a mapping's `typeRules` describe them (see `indexer/src/extract/types.ts`).
struct TypeCollector<'r> {
    by_node: HashMap<&'r str, Vec<&'r TypeBinding>>,
    class_types: HashSet<&'r str>,
    non_classes: HashSet<String>,
    types: Vec<TypeFact>,
}

impl<'r> TypeCollector<'r> {
    fn new(rules: &'r TypeRules) -> Self {
        let mut by_node: HashMap<&str, Vec<&TypeBinding>> = HashMap::new();
        for binding in &rules.bindings {
            by_node
                .entry(binding.node.as_str())
                .or_default()
                .push(binding);
        }
        TypeCollector {
            by_node,
            class_types: rules.class_types.iter().map(String::as_str).collect(),
            non_classes: rules.non_classes.iter().map(|n| n.to_lowercase()).collect(),
            types: Vec::new(),
        }
    }

    fn push(&mut self, scope: &str, name: &str, type_name: String, origin: &str) {
        self.types.push(TypeFact {
            scope: scope.to_string(),
            name: name.to_string(),
            type_name,
            origin: origin.to_string(),
        });
    }

    fn visit(&mut self, node: Node, source: &str, at: u32, scope: &mut NestingCursor) {
        let Some(bindings) = self.by_node.get(node.kind()).cloned() else {
            return;
        };
        for binding in bindings {
            if binding.origin == "assigned" {
                self.assigned(node, binding, source, at, scope);
            } else {
                self.declared(node, binding, source, at, scope);
            }
        }
    }

    fn declared(
        &mut self,
        node: Node,
        binding: &TypeBinding,
        source: &str,
        at: u32,
        scope: &mut NestingCursor,
    ) {
        let type_name = self.class_of(field(node, &binding.type_field), source);
        let scope = scope.at(at);
        let (Some(type_name), Some(scope)) = (type_name, scope) else {
            return;
        };
        if binding.origin == "return" {
            self.push(scope, "", type_name, "return");
            return;
        }
        let holders: Vec<Node> = match &binding.each {
            None => vec![node],
            Some(each) => named_children(node)
                .into_iter()
                .filter(|child| child.kind() == each)
                .collect(),
        };
        for holder in holders {
            if let Some(name) = name_of(
                field(holder, &binding.name_field),
                &binding.name_type,
                source,
            ) {
                self.push(scope, name, type_name.clone(), &binding.origin);
            }
        }
    }

    fn assigned(
        &mut self,
        node: Node,
        binding: &TypeBinding,
        source: &str,
        at: u32,
        scope: &mut NestingCursor,
    ) {
        let Some(value) = field(node, &binding.value_field) else {
            return;
        };
        if Some(value.kind()) != binding.value_type.as_deref() {
            return;
        }
        let Some(name) = name_of(field(node, &binding.name_field), &binding.name_type, source)
        else {
            return;
        };
        let created_types = binding.created_types.as_deref().unwrap_or(&[]);
        let created = named_children(value)
            .into_iter()
            .find(|child| created_types.iter().any(|t| t == child.kind()));
        let scope = scope.at(at);
        let (Some(created), Some(scope)) = (created, scope) else {
            return;
        };
        let created = text(created, source);
        if self.non_classes.contains(&created.to_lowercase()) {
            return;
        }
        self.push(scope, name, created.to_string(), "assigned");
    }

    /// The one class a type names; `None` for unions of classes and for scalars.
    fn class_of(&self, node: Option<Node>, source: &str) -> Option<String> {
        let node = node?;
        let mut found: Vec<String> = Vec::new();
        let mut pending = vec![node];
        while let Some(current) = pending.pop() {
            if self.class_types.contains(current.kind()) {
                let name = text(current, source).trim();
                if !self.non_classes.contains(&name.to_lowercase())
                    && !found.iter().any(|f| f == name)
                {
                    found.push(name.to_string());
                }
                continue;
            }
            pending.extend(named_children(current));
        }
        (found.len() == 1).then(|| found.remove(0))
    }
}

fn field<'t>(node: Node<'t>, name: &Option<String>) -> Option<Node<'t>> {
    name.as_deref()
        .and_then(|name| node.child_by_field_name(name))
}

fn name_of<'s>(node: Option<Node>, expected: &Option<String>, source: &'s str) -> Option<&'s str> {
    let node = node?;
    if let Some(expected) = expected {
        if node.kind() != expected {
            return None;
        }
    }
    Some(text(node, source))
}
