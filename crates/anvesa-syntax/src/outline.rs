//! The W-expression outline, built natively from a `LanguageMapping`.
//!
//! A port of `structural/src/encode.ts` and `structural/src/symbols.ts`: the same mapping JSON
//! drives it (bundled, trained, extended, from `tags.scm` or assisted), and it writes the same
//! attributes, names, signatures and hashes, so an outline built here and one built on
//! web-tree-sitter can be compared node for node. The parity tests on the TypeScript side hold
//! the two to that.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use tree_sitter::{Node, Parser, Tree};

// --- the mapping -----------------------------------------------------------------------------------

/// How one language's node types become outline tags. The JSON a mapping file holds; fields the
/// encoder does not read (`symbolRules`, a legacy `maxDepth`) are ignored.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanguageMapping {
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    pub node_type_map: HashMap<String, String>,
    pub structural_tags: Vec<String>,
    pub name_extractors: HashMap<String, String>,
    #[serde(default)]
    pub callable_tags: Option<Vec<String>>,
    /// Where the source declares which class a name holds (see `TypeRules`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_rules: Option<TypeRules>,
}

/// Declared types, as data: which syntax nodes bind a name to a class the source writes.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeRules {
    /// Node types inside a type expression that name a class.
    pub class_types: Vec<String>,
    /// Type names that are not classes, compared in lower case.
    pub non_classes: Vec<String>,
    pub bindings: Vec<TypeBinding>,
}

/// One kind of syntax node that binds a name to a type.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TypeBinding {
    pub node: String,
    /// `param`, `property`, `promoted`, `assigned` or `return`.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub each: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_types: Option<Vec<String>>,
}

/// Tags treated as callable when a mapping does not say otherwise.
const DEFAULT_CALLABLE_TAGS: [&str; 6] = [
    "function",
    "method",
    "arrow",
    "lambda",
    "closure",
    "constructor",
];

/// A mapping prepared for lookups during encoding.
pub struct CompiledMapping<'m> {
    mapping: &'m LanguageMapping,
    structural: HashSet<&'m str>,
    callable: HashSet<String>,
}

impl<'m> CompiledMapping<'m> {
    pub fn new(mapping: &'m LanguageMapping) -> Self {
        let callable = match &mapping.callable_tags {
            Some(tags) => tags.iter().cloned().collect(),
            None => DEFAULT_CALLABLE_TAGS
                .iter()
                .map(|tag| tag.to_string())
                .collect(),
        };
        CompiledMapping {
            mapping,
            structural: mapping.structural_tags.iter().map(String::as_str).collect(),
            callable,
        }
    }
    /// The tag for a node type; types the mapping does not list keep their own name.
    pub fn tag_of(&self, node_type: &'static str) -> &str {
        self.mapping
            .node_type_map
            .get(node_type)
            .map(String::as_str)
            .unwrap_or(node_type)
    }
    pub fn is_structural(&self, tag: &str) -> bool {
        self.structural.contains(tag)
    }
    pub fn is_callable(&self, tag: &str) -> bool {
        self.callable.contains(tag)
    }
    fn name_child_type(&self, node_type: &str) -> Option<&str> {
        self.mapping
            .name_extractors
            .get(node_type)
            .map(String::as_str)
    }
}

// --- the outline -----------------------------------------------------------------------------------

/// One outline node: a tag, string attributes and children.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WNode {
    pub tag: String,
    pub attrs: Attrs,
    pub children: Vec<WNode>,
}

/// String attributes in the order they were first set, as a JavaScript `Map` keeps them, so an
/// outline serialised here reads the same as one serialised on the TypeScript side.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs(Vec<(String, String)>);

impl Attrs {
    pub fn new() -> Self {
        Attrs(Vec::new())
    }
    /// Set a value; a key already set keeps its place, as `Map.set` does.
    pub fn insert(&mut self, key: String, value: String) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }
    pub fn get(&self, key: &str) -> Option<&String> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(String, String)> {
        self.0.iter()
    }
}

impl Serialize for Attrs {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Attrs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Attrs;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a map of string attributes")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Attrs, M::Error> {
                let mut attrs = Attrs::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    attrs.insert(key, value);
                }
                Ok(attrs)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

#[derive(Debug, Clone, Default)]
pub struct EncodeOptions {
    /// Recorded as the root's `path` attribute.
    pub path: Option<String>,
    /// Record each symbol's doc comment as `doc`.
    pub docs: bool,
    /// Record `startIndex` / `endIndex`, as UTF-16 offsets like the TypeScript side.
    pub positions: bool,
    /// Stop below this structural depth; what is cut off is counted, never dropped silently.
    pub max_depth: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodeStats {
    pub nodes: u32,
    pub deepest: u32,
    pub omitted: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncodedFile {
    pub root: WNode,
    pub stats: EncodeStats,
    pub has_errors: bool,
    pub symbols: Vec<OutlineSymbol>,
}

/// Parse `source` and encode it. `None` when no grammar for `language` is compiled in.
pub fn encode_source(
    source: &str,
    language: &str,
    mapping: &LanguageMapping,
    options: &EncodeOptions,
) -> Option<EncodedFile> {
    let grammar = crate::get_tree_sitter_language(language)?;
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;
    let tree: Tree = parser.parse(source, None)?;
    let compiled = CompiledMapping::new(mapping);
    let (root, stats) = encode_tree(tree.root_node(), source, &compiled, options);
    let symbols = outline_symbols(&root);
    Some(EncodedFile {
        root,
        stats,
        has_errors: tree.root_node().has_error(),
        symbols,
    })
}

struct Ctx<'s, 'm> {
    source: &'s str,
    mapping: &'m CompiledMapping<'m>,
    shapes: HashMap<usize, CallableShape>,
    options: &'m EncodeOptions,
    /// Byte offset -> UTF-16 offset, built only when positions are asked for.
    utf16: Option<Vec<u32>>,
}

struct Task<'t> {
    syntax: Node<'t>,
    /// Index into the arena of the outline node being filled.
    into: usize,
    depth: u32,
    qualifier: Option<Rc<str>>,
    parent_tag: Rc<str>,
}

/// Turn a syntax tree into an outline. Iterative, so nesting cannot overflow the stack.
pub fn encode_tree(
    root: Node,
    source: &str,
    mapping: &CompiledMapping,
    options: &EncodeOptions,
) -> (WNode, EncodeStats) {
    let ctx = Ctx {
        source,
        mapping,
        shapes: callable_shapes(root, source, mapping),
        options,
        utf16: options.positions.then(|| utf16_offsets(source)),
    };
    let root_tag: Rc<str> = Rc::from(mapping.tag_of(root.kind()));
    let top = start_node(
        &ctx,
        root,
        &root_tag,
        None,
        &root_tag,
        options.path.as_deref(),
    );
    let top_name: Option<Rc<str>> = top.attrs.get("name").map(|name| Rc::from(name.as_str()));
    // Nodes are built flat, each knowing its children by index, and assembled at the end.
    let mut arena: Vec<(WNode, Vec<usize>)> = vec![(top, Vec::new())];

    let mut deepest = 0u32;
    let mut omitted = 0u32;
    let mut pending: Vec<Task> = Vec::new();
    push_children(&mut pending, root, 0, 0, &top_name, &root_tag);

    while let Some(task) = pending.pop() {
        let tag = mapping.tag_of(task.syntax.kind());
        if !mapping.is_structural(tag) {
            push_children(
                &mut pending,
                task.syntax,
                task.into,
                task.depth,
                &task.qualifier,
                &task.parent_tag,
            );
            continue;
        }
        let depth = task.depth + 1;
        if let Some(max) = options.max_depth {
            if depth > max {
                omitted += 1;
                continue;
            }
        }
        let node = start_node(
            &ctx,
            task.syntax,
            tag,
            task.qualifier.as_deref(),
            &task.parent_tag,
            None,
        );
        let qualifier = match node.attrs.get("name") {
            Some(name) => Some(Rc::from(name.as_str())),
            None => task.qualifier,
        };
        let index = arena.len();
        arena.push((node, Vec::new()));
        arena[task.into].1.push(index);
        deepest = deepest.max(depth);
        push_children(
            &mut pending,
            task.syntax,
            index,
            depth,
            &qualifier,
            &Rc::from(tag),
        );
    }
    let nodes = arena.len() as u32;
    (
        assemble(arena),
        EncodeStats {
            nodes,
            deepest,
            omitted,
        },
    )
}

/// Turn the flat arena into a tree. Children always come after their parent in the arena, so
/// filling from the back hands each parent finished children.
fn assemble(arena: Vec<(WNode, Vec<usize>)>) -> WNode {
    let mut built: Vec<Option<WNode>> = Vec::with_capacity(arena.len());
    let mut links: Vec<Vec<usize>> = Vec::with_capacity(arena.len());
    for (node, children) in arena {
        built.push(Some(node));
        links.push(children);
    }
    for index in (0..built.len()).rev() {
        let children: Vec<WNode> = links[index]
            .iter()
            .map(|&child| built[child].take().expect("a child is assembled once"))
            .collect();
        if let Some(node) = built[index].as_mut() {
            node.children = children;
        }
    }
    built[0].take().expect("the root is there")
}

fn push_children<'t>(
    pending: &mut Vec<Task<'t>>,
    syntax: Node<'t>,
    into: usize,
    depth: u32,
    qualifier: &Option<Rc<str>>,
    parent_tag: &Rc<str>,
) {
    let mut cursor = syntax.walk();
    let start = pending.len();
    for child in syntax.children(&mut cursor) {
        if child.is_named() {
            pending.push(Task {
                syntax: child,
                into,
                depth,
                qualifier: qualifier.clone(),
                parent_tag: parent_tag.clone(),
            });
        }
    }
    // The stack pops from the end: reverse so the first child is handled first.
    pending[start..].reverse();
}

fn all_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

fn named_children(node: Node) -> Vec<Node> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor).collect()
}

fn text<'s>(node: Node, source: &'s str) -> &'s str {
    &source[node.start_byte()..node.end_byte()]
}

fn start_node(
    ctx: &Ctx,
    syntax: Node,
    tag: &str,
    qualifier: Option<&str>,
    parent_tag: &str,
    path: Option<&str>,
) -> WNode {
    let mut attrs = Attrs::new();
    let base = name_text(syntax, ctx);
    if let Some(base) = &base {
        let name = match qualifier {
            Some(q) if !q.is_empty() => format!("{q}.{base}"),
            _ => base.clone(),
        };
        attrs.insert("name".to_string(), name);
        attrs.insert("baseName".to_string(), base.clone());
    }
    attrs.insert("kind".to_string(), syntax.kind().to_string());
    if tag == "variable" && base.is_some() {
        if let Some(alias) = alias_target(syntax, ctx.source) {
            attrs.insert("aliasOf".to_string(), alias);
        }
    }
    if declares(tag, syntax.kind(), base.is_some()) {
        attrs.insert("declaration".to_string(), "true".to_string());
    }
    attrs.insert(
        "line".to_string(),
        (syntax.start_position().row + 1).to_string(),
    );
    attrs.insert(
        "endLine".to_string(),
        (syntax.end_position().row + 1).to_string(),
    );
    if let Some(path) = path {
        attrs.insert("path".to_string(), path.to_string());
    }
    if ctx.options.docs {
        if let Some(doc) = doc_of(syntax, ctx.source) {
            attrs.insert("doc".to_string(), doc);
        }
    }
    if let Some(table) = &ctx.utf16 {
        attrs.insert(
            "startIndex".to_string(),
            table[syntax.start_byte()].to_string(),
        );
        attrs.insert("endIndex".to_string(), table[syntax.end_byte()].to_string());
    }
    if ctx.mapping.is_callable(tag) {
        describe_callable(
            ctx,
            syntax,
            &mut attrs,
            base.as_deref(),
            qualifier,
            parent_tag,
        );
    }
    WNode {
        tag: tag.to_string(),
        attrs,
        children: Vec::new(),
    }
}

/// For every byte offset (and one past the end), the UTF-16 offset of the same position.
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

// --- docs ------------------------------------------------------------------------------------------

const DOC_WRAPPER_TYPES: [&str; 2] = ["decorated_definition", "export_statement"];

fn is_comment(kind: &str) -> bool {
    kind.contains("comment")
}

fn doc_of(syntax: Node, source: &str) -> Option<String> {
    let mut anchor = syntax;
    while let Some(parent) = anchor.parent() {
        let wraps = parent.start_byte() == anchor.start_byte()
            || DOC_WRAPPER_TYPES.contains(&parent.kind());
        if wraps && parent.parent().is_some() {
            anchor = parent;
        } else {
            break;
        }
    }
    let mut comments: Vec<&str> = Vec::new();
    let mut expected_row = anchor.start_position().row;
    let mut prev = anchor.prev_sibling();
    while let Some(node) = prev {
        if !is_comment(node.kind()) {
            break;
        }
        if node.end_position().row + 1 < expected_row {
            break;
        }
        comments.insert(0, text(node, source));
        expected_row = node.start_position().row;
        prev = node.prev_sibling();
    }
    if !comments.is_empty() {
        return Some(comments.join("\n"));
    }
    let first = syntax
        .child_by_field_name("body")
        .and_then(|body| body.named_child(0))?;
    let literal = if first.kind() == "expression_statement" {
        first.named_child(0)?
    } else {
        first
    };
    if literal.kind() == "string" || literal.kind() == "string_literal" {
        return Some(text(literal, source).to_string());
    }
    None
}

// --- names -----------------------------------------------------------------------------------------

const NAME_TYPES: [&str; 4] = [
    "identifier",
    "type_identifier",
    "property_identifier",
    "name",
];
const DECLARATOR_TYPES: [&str; 3] = [
    "variable_declarator",
    "public_field_definition",
    "field_definition",
];
const NON_NAME_FIELDS: [&str; 5] = ["body", "parameter", "parameters", "return_type", "value"];

fn name_text(syntax: Node, ctx: &Ctx) -> Option<String> {
    let explicit = ctx.mapping.name_child_type(syntax.kind());
    if let Some(direct) = name_child(syntax, explicit) {
        return Some(text(direct, ctx.source).to_string());
    }
    for child in all_children(syntax) {
        if DECLARATOR_TYPES.contains(&child.kind()) {
            if let Some(wrapped) = name_child(child, explicit) {
                return Some(text(wrapped, ctx.source).to_string());
            }
        }
    }
    None
}

fn name_child<'t>(syntax: Node<'t>, explicit: Option<&str>) -> Option<Node<'t>> {
    if let Some(field) = syntax.child_by_field_name("name") {
        return Some(field);
    }
    let other: HashSet<usize> = NON_NAME_FIELDS
        .iter()
        .filter_map(|role| syntax.child_by_field_name(role).map(|child| child.id()))
        .collect();
    all_children(syntax).into_iter().find(|child| {
        !other.contains(&child.id())
            && match explicit {
                None => NAME_TYPES.contains(&child.kind()),
                Some(wanted) => child.kind() == wanted,
            }
    })
}

// --- callables -------------------------------------------------------------------------------------

const PARAMETER_LIST_TYPES: [&str; 3] = ["formal_parameters", "parameters", "parameter_list"];
const VALUE_WRAPPERS: [&str; 5] = [
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "non_null_expression",
    "type_assertion",
];
const VALUE_HOSTS: [&str; 4] = [
    "variable_declarator",
    "public_field_definition",
    "field_definition",
    "property_definition",
];
const CLASS_LIKE_PARENT_TAGS: [&str; 5] = ["class", "struct", "interface", "trait", "impl"];

fn is_assigned_value(syntax: Node) -> bool {
    let mut parent = syntax.parent();
    while let Some(node) = parent {
        if VALUE_WRAPPERS.contains(&node.kind()) {
            parent = node.parent();
        } else {
            break;
        }
    }
    parent.is_some_and(|node| VALUE_HOSTS.contains(&node.kind()))
}

fn describe_callable(
    ctx: &Ctx,
    syntax: Node,
    attrs: &mut Attrs,
    base_name: Option<&str>,
    qualifier: Option<&str>,
    parent_tag: &str,
) {
    attrs.insert("callable".to_string(), "true".to_string());
    if CLASS_LIKE_PARENT_TAGS.contains(&parent_tag)
        || syntax.kind() == "method_declaration"
        || syntax.kind() == "method_definition"
    {
        attrs.insert("isMethod".to_string(), "true".to_string());
    }
    let params = parameters_of(syntax, ctx.source);
    let returns = return_type_of(syntax, ctx.source);
    if let Some(params) = &params {
        attrs.insert("params".to_string(), params.clone());
    }
    if let Some(returns) = &returns {
        attrs.insert("returns".to_string(), returns.clone());
    }

    let label: Option<String> = match base_name {
        Some(base) => Some(base.to_string()),
        None if (parent_tag == "variable" || parent_tag == "property")
            && is_assigned_value(syntax) =>
        {
            qualifier.map(str::to_string)
        }
        None => None,
    };
    if base_name.is_none() {
        if let Some(label) = &label {
            attrs.insert("assignedTo".to_string(), label.clone());
        }
    }
    let qualified = match base_name {
        None => label.clone().unwrap_or_default(),
        Some(base) => match qualifier {
            Some(q) if !q.is_empty() => format!("{q}.{base}"),
            _ => base.to_string(),
        },
    };
    let params_text = params.clone().unwrap_or_default();
    let returns_suffix = returns
        .as_ref()
        .map(|r| format!(":{r}"))
        .unwrap_or_default();
    attrs.insert(
        "signature".to_string(),
        format!("{qualified}({params_text}){returns_suffix}"),
    );
    let label_text = label.unwrap_or_default();
    attrs.insert(
        "hash".to_string(),
        short_hash(&format!("{label_text}({params_text}){returns_suffix}")),
    );

    if let Some(body) = classify_body(syntax, ctx.source) {
        attrs.insert("bodyKind".to_string(), body.0.to_string());
        attrs.insert("bodyStmts".to_string(), body.1.to_string());
    }
    if let Some(shape) = ctx.shapes.get(&syntax.id()) {
        attrs.insert("shape".to_string(), shape.hash.clone());
        attrs.insert("shapeNodes".to_string(), shape.nodes.to_string());
        if let Some(body) = &shape.body {
            attrs.insert("bodyShape".to_string(), body.clone());
        }
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_of(bytes: &[u8], chars: usize) -> String {
    let mut out = String::with_capacity(chars);
    for byte in bytes {
        if out.len() >= chars {
            break;
        }
        out.push(HEX[(byte >> 4) as usize] as char);
        if out.len() < chars {
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    out
}

fn sha256_hex(text: &str) -> String {
    hex_of(&Sha256::digest(text.as_bytes()), 64)
}

/// The width stored in attributes: 16 hex characters (64 bits).
const DIGEST_HEX_LENGTH: usize = 16;
/// Node-to-node digests inside a shape hash: 32 hex characters.
const NODE_DIGEST_HEX_LENGTH: usize = 32;

fn short_digest(full: &str) -> String {
    full.chars().take(DIGEST_HEX_LENGTH).collect()
}

fn short_hash(text: &str) -> String {
    short_digest(&sha256_hex(text))
}

fn parameters_of(syntax: Node, source: &str) -> Option<String> {
    let list = syntax.child_by_field_name("parameters").or_else(|| {
        all_children(syntax)
            .into_iter()
            .find(|child| PARAMETER_LIST_TYPES.contains(&child.kind()))
    });
    let Some(list) = list else {
        return syntax
            .child_by_field_name("parameter")
            .and_then(|single| param_label(single, source));
    };
    let labels: Vec<String> = all_children(list)
        .into_iter()
        .filter(|param| param.is_named() && !is_comment(param.kind()))
        .filter_map(|param| param_label(param, source))
        .collect();
    (!labels.is_empty()).then(|| labels.join(", "))
}

fn splat_prefix(kind: &str) -> Option<&'static str> {
    match kind {
        "rest_pattern" | "rest_parameter" | "list_splat_pattern" => Some("..."),
        "dictionary_splat_pattern" => Some("**"),
        _ => None,
    }
}

fn param_label(param: Node, source: &str) -> Option<String> {
    let kind = param.kind();
    if kind == "identifier" || kind == "shorthand_property_identifier_pattern" {
        return Some(text(param, source).to_string());
    }
    if let Some(splat) = splat_prefix(kind) {
        let inner = param
            .named_child(0)
            .map(|inner| {
                param_label(inner, source).unwrap_or_else(|| text(inner, source).to_string())
            })
            .unwrap_or_default();
        return Some(format!("{splat}{inner}"));
    }
    if kind == "object_pattern" || kind == "array_pattern" {
        return Some(format!("{{{}}}", pattern_names(param, source).join(", ")));
    }
    if let Some(named) = param
        .child_by_field_name("name")
        .or_else(|| param.child_by_field_name("pattern"))
    {
        return Some(param_label(named, source).unwrap_or_else(|| text(named, source).to_string()));
    }
    if let Some(first) = named_children(param)
        .into_iter()
        .find(|child| child.kind().ends_with("identifier"))
    {
        return Some(text(first, source).to_string());
    }
    let whole = text(param, source);
    let head = whole.split([':', '=']).next().unwrap_or("").trim();
    (!head.is_empty()).then(|| head.to_string())
}

fn pattern_names(pattern: Node, source: &str) -> Vec<String> {
    let mut names = Vec::new();
    for child in named_children(pattern) {
        if child.kind() == "pair_pattern" {
            if let Some(value) = child.child_by_field_name("value") {
                if value.kind() == "identifier" {
                    names.push(text(value, source).to_string());
                }
            }
        } else if child.kind() == "identifier"
            || child.kind() == "shorthand_property_identifier_pattern"
        {
            names.push(text(child, source).to_string());
        }
    }
    names
}

/// JavaScript's `\s`: Unicode white space plus the line terminators and BOM.
fn is_js_space(ch: char) -> bool {
    ch.is_whitespace() || ch == '\u{feff}'
}

fn return_type_of(syntax: Node, source: &str) -> Option<String> {
    let node = syntax.child_by_field_name("return_type").or_else(|| {
        all_children(syntax)
            .into_iter()
            .find(|child| child.kind() == "type_annotation")
    })?;
    let raw = text(node, source).trim_start_matches(is_js_space);
    let raw = raw
        .strip_prefix(':')
        .or_else(|| raw.strip_prefix("->"))
        .map(|rest| rest.trim_start_matches(is_js_space))
        .unwrap_or(raw);
    let mut collapsed = String::with_capacity(raw.len());
    let mut in_space = false;
    for ch in raw.chars() {
        if is_js_space(ch) {
            in_space = true;
        } else {
            if in_space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            in_space = false;
            collapsed.push(ch);
        }
    }
    (!collapsed.is_empty()).then_some(collapsed)
}

// --- body classification ---------------------------------------------------------------------------

const LITERAL_TYPES: [&str; 15] = [
    "string",
    "string_literal",
    "template_string",
    "number",
    "number_literal",
    "integer",
    "float",
    "true",
    "false",
    "null",
    "nil",
    "none",
    "undefined",
    "boolean",
    "regex",
];
const NO_OP_STATEMENTS: [&str; 3] = ["pass_statement", "ellipsis", "empty_statement"];
const THROW_STATEMENTS: [&str; 2] = ["throw_statement", "raise_statement"];

fn is_literal_type(kind: &str) -> bool {
    LITERAL_TYPES.contains(&kind)
}

fn is_block_body(kind: &str) -> bool {
    kind.contains("block")
        || kind.contains("compound_statement")
        || kind.contains("declaration_list")
        || kind == "body"
}

fn is_literal(node: Node) -> bool {
    is_literal_type(node.kind())
        || ((node.kind() == "array" || node.kind() == "object") && node.named_child_count() == 0)
}

/// How much a callable's body does: (kind, statements). `None` without a body.
fn classify_body(callable: Node, _source: &str) -> Option<(&'static str, usize)> {
    let body = callable.child_by_field_name("body")?;
    if !is_block_body(body.kind()) {
        return Some((
            if is_literal(body) {
                "return-literal"
            } else {
                "real"
            },
            1,
        ));
    }
    let children = named_children(body);
    let statements: Vec<Node> = children
        .iter()
        .copied()
        .filter(|child| !is_comment(child.kind()))
        .collect();
    let has_comments = children.iter().any(|child| is_comment(child.kind()));
    if statements.len() == 1 {
        let only = statements[0];
        let inner = if only.kind() == "expression_statement" {
            only.named_child(0).unwrap_or(only)
        } else {
            only
        };
        if inner.kind() == "string" || inner.kind() == "string_literal" {
            return Some(("comment-only", 0));
        }
    }
    let effective: Vec<Node> = statements
        .into_iter()
        .filter(|child| !NO_OP_STATEMENTS.contains(&child.kind()))
        .collect();
    if effective.is_empty() {
        return Some((
            if has_comments {
                "comment-only"
            } else {
                "empty"
            },
            0,
        ));
    }
    if effective.len() == 1 {
        let only = effective[0];
        if THROW_STATEMENTS.contains(&only.kind()) {
            return Some(("throw-only", 1));
        }
        if only.kind() == "return_statement" {
            let value = named_children(only)
                .into_iter()
                .find(|child| !is_comment(child.kind()));
            if value.is_none_or(is_literal) {
                return Some(("return-literal", 1));
            }
        }
    }
    Some(("real", effective.len()))
}

// --- structural shape ------------------------------------------------------------------------------

struct CallableShape {
    hash: String,
    nodes: u32,
    body: Option<String>,
}

/// What a child contributes to its parent's digest.
enum Token {
    /// A name, whatever it was: `ID`.
    Id,
    /// A literal value, by its type: `<type>:LIT`.
    Literal(&'static str),
    /// A childless node: its type.
    Leaf(&'static str),
    /// A subtree: its 32-hex-character digest.
    Digest(String),
}

impl Token {
    fn write(&self, out: &mut String) {
        match self {
            Token::Id => out.push_str("ID"),
            Token::Literal(kind) => {
                out.push_str(kind);
                out.push_str(":LIT");
            }
            Token::Leaf(kind) => out.push_str(kind),
            Token::Digest(digest) => out.push_str(digest),
        }
    }
    fn text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }
}

fn leaf_token(node: Node) -> Option<Token> {
    let kind = node.kind();
    if kind.ends_with("identifier") {
        return Some(Token::Id);
    }
    if is_literal_type(kind)
        || matches!(
            kind,
            "string_fragment" | "string_content" | "escape_sequence"
        )
    {
        return Some(Token::Literal(kind));
    }
    (node.child_count() == 0).then_some(Token::Leaf(kind))
}

struct ShapeFrame<'t> {
    node: Node<'t>,
    cursor: tree_sitter::TreeCursor<'t>,
    started: bool,
    tokens: Vec<Token>,
    child_ids: Vec<usize>,
    named: u32,
}

fn open_frame(node: Node<'_>) -> ShapeFrame<'_> {
    ShapeFrame {
        node,
        cursor: node.walk(),
        started: false,
        tokens: Vec::new(),
        child_ids: Vec::new(),
        named: 0,
    }
}

/// The frame's next child, walking its cursor.
fn next_child<'t>(frame: &mut ShapeFrame<'t>) -> Option<Node<'t>> {
    let moved = if frame.started {
        frame.cursor.goto_next_sibling()
    } else {
        frame.started = true;
        frame.cursor.goto_first_child()
    };
    moved.then(|| frame.cursor.node())
}

/// Shapes of every callable, keyed by syntax node id, in one bottom-up pass over the tree: a
/// node's digest is built from its children's, with names and literal values replaced.
fn callable_shapes(
    root: Node,
    _source: &str,
    mapping: &CompiledMapping,
) -> HashMap<usize, CallableShape> {
    let mut shapes = HashMap::new();
    let mut stack = vec![open_frame(root)];
    let mut input = String::new();
    while let Some(frame) = stack.last_mut() {
        if let Some(child) = next_child(frame) {
            if is_comment(child.kind()) {
                continue;
            }
            if let Some(leaf) = leaf_token(child) {
                frame.tokens.push(leaf);
                frame.child_ids.push(child.id());
                if child.is_named() {
                    frame.named += 1;
                }
            } else {
                stack.push(open_frame(child));
            }
            continue;
        }
        let frame = stack.pop().expect("a frame is open");
        input.clear();
        input.push_str(frame.node.kind());
        input.push('[');
        for (index, token) in frame.tokens.iter().enumerate() {
            if index > 0 {
                input.push(',');
            }
            token.write(&mut input);
        }
        input.push(']');
        let digest = hex_of(&Sha256::digest(input.as_bytes()), NODE_DIGEST_HEX_LENGTH);
        let nodes = frame.named + u32::from(frame.node.is_named());
        if mapping.is_callable(mapping.tag_of(frame.node.kind())) {
            let body_id = frame.node.child_by_field_name("body").map(|body| body.id());
            let body = body_id
                .and_then(|id| frame.child_ids.iter().position(|&child| child == id))
                .map(|at| short_digest(&frame.tokens[at].text()));
            shapes.insert(
                frame.node.id(),
                CallableShape {
                    hash: short_digest(&digest),
                    nodes,
                    body,
                },
            );
        }
        if let Some(parent) = stack.last_mut() {
            parent.tokens.push(Token::Digest(digest));
            parent.child_ids.push(frame.node.id());
            parent.named += nodes;
        }
    }
    shapes
}

fn alias_target(declaration: Node, source: &str) -> Option<String> {
    for declarator in named_children(declaration) {
        if declarator.kind() != "variable_declarator" {
            continue;
        }
        if let Some(value) = declarator.child_by_field_name("value") {
            if value.kind() == "identifier" {
                return Some(text(value, source).to_string());
            }
        }
    }
    None
}

// --- symbols ---------------------------------------------------------------------------------------

const SYMBOL_TAGS: [&str; 11] = [
    "function",
    "method",
    "class",
    "struct",
    "interface",
    "type",
    "enum",
    "trait",
    "module",
    "namespace",
    "constant",
];

fn is_declaration_kind(kind: &str) -> bool {
    [
        "_declaration",
        "_definition",
        "_item",
        "_statement",
        "_spec",
        "_alias",
    ]
    .iter()
    .any(|suffix| kind.ends_with(suffix))
}

/// Whether a node declares what it names (as opposed to mentioning it).
pub fn declares(tag: &str, kind: &str, named: bool) -> bool {
    if !named || matches!(tag, "import" | "export" | "call") {
        return false;
    }
    if tag == "type" {
        return is_declaration_kind(kind);
    }
    SYMBOL_TAGS.contains(&tag) || tag == "variable"
}

/// A named declaration in an outline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub kind: String,
    pub name: String,
    pub base_name: String,
    pub parent_name: String,
    pub line: u32,
    pub end_line: u32,
    pub doc: Option<String>,
    pub signature: Option<String>,
    pub params: Option<String>,
    pub exported: Option<bool>,
    pub alias_of: Option<String>,
    /// Where the symbol's node starts and ends (UTF-16 offsets), when positions were recorded.
    #[serde(skip)]
    pub start_index: Option<u32>,
    #[serde(skip)]
    pub end_index: Option<u32>,
}

/// The symbols of an outline, in document order (see `structural/src/symbols.ts`).
pub fn outline_symbols(root: &WNode) -> Vec<OutlineSymbol> {
    let has_exports = {
        let mut found = false;
        let mut pending = vec![root];
        while let Some(node) = pending.pop() {
            if node.tag == "export" {
                found = true;
                break;
            }
            pending.extend(node.children.iter());
        }
        found
    };
    let mut symbols = Vec::new();
    // Document order: parents before children, siblings left to right.
    let mut pending: Vec<(&WNode, Option<&WNode>)> = vec![(root, None)];
    while let Some((node, parent)) = pending.pop() {
        for child in node.children.iter().rev() {
            pending.push((child, Some(node)));
        }
        let Some(name) = node.attrs.get("name") else {
            continue;
        };
        let doc = node.attrs.get("doc").cloned();
        let base_name = node
            .attrs
            .get("baseName")
            .cloned()
            .unwrap_or_else(|| name.clone());
        let parent_name = if name.ends_with(base_name.as_str()) {
            let head = &name[..name.len() - base_name.len()];
            head.strip_suffix('.').unwrap_or(head).to_string()
        } else {
            String::new()
        };
        let exported = parent
            .map(|parent| parent.tag == "export")
            .and_then(|direct| {
                if direct {
                    Some(true)
                } else if has_exports {
                    Some(false)
                } else {
                    None
                }
            });
        let kind = node.attrs.get("kind").map(String::as_str).unwrap_or("");
        if node.tag == "type" && !is_declaration_kind(kind) {
            continue;
        }
        let line = |key: &str| {
            node.attrs
                .get(key)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        let make = |kind: &str,
                    doc: Option<String>,
                    signature: Option<String>,
                    params: Option<String>,
                    alias_of: Option<String>| OutlineSymbol {
            kind: kind.to_string(),
            name: name.clone(),
            base_name: base_name.clone(),
            parent_name: parent_name.clone(),
            line: line("line"),
            end_line: line("endLine"),
            doc,
            signature,
            params,
            exported,
            alias_of,
            start_index: node.attrs.get("startIndex").and_then(|v| v.parse().ok()),
            end_index: node.attrs.get("endIndex").and_then(|v| v.parse().ok()),
        };
        if SYMBOL_TAGS.contains(&node.tag.as_str()) {
            symbols.push(make(
                &node.tag,
                doc,
                node.attrs.get("signature").cloned(),
                node.attrs.get("params").cloned(),
                None,
            ));
        } else if node.tag == "variable" {
            let callable = node
                .children
                .iter()
                .find(|child| child.attrs.get("assignedTo") == Some(name));
            if let Some(callable) = callable {
                let doc = doc.or_else(|| callable.attrs.get("doc").cloned());
                symbols.push(make(
                    "function",
                    doc,
                    callable.attrs.get("signature").cloned(),
                    callable.attrs.get("params").cloned(),
                    None,
                ));
            } else if doc.is_some() || node.attrs.contains_key("aliasOf") {
                symbols.push(make(
                    "variable",
                    doc,
                    None,
                    None,
                    node.attrs.get("aliasOf").cloned(),
                ));
            }
        }
    }
    symbols
}

/// The outline as compact W-expression text, exactly as `serializeWExpr` in
/// `structural/src/text.ts` writes it: `(tag key="value" (child))`, attributes in the order they
/// were set and before children, and in a value only `\\`, `\"`, `\n`, `\r` and `\t` escaped.
/// Attributes named in `omit` are left out. Iterative, so a deep outline cannot overflow the stack.
pub fn serialize_wexpr(root: &WNode, omit: &[String]) -> String {
    enum Step<'a> {
        Open(&'a WNode),
        Close,
    }
    let mut out = String::with_capacity(256);
    let mut stack = vec![Step::Open(root)];
    let mut first = true;
    while let Some(step) = stack.pop() {
        match step {
            Step::Open(node) => {
                if !first {
                    out.push(' ');
                }
                first = false;
                out.push('(');
                out.push_str(&node.tag);
                for (key, value) in &node.attrs.0 {
                    if omit.iter().any(|left_out| left_out == key) {
                        continue;
                    }
                    out.push(' ');
                    out.push_str(key);
                    out.push_str("=\"");
                    for char in value.chars() {
                        match char {
                            '\\' => out.push_str("\\\\"),
                            '"' => out.push_str("\\\""),
                            '\n' => out.push_str("\\n"),
                            '\r' => out.push_str("\\r"),
                            '\t' => out.push_str("\\t"),
                            other => out.push(other),
                        }
                    }
                    out.push('"');
                }
                stack.push(Step::Close);
                for child in node.children.iter().rev() {
                    stack.push(Step::Open(child));
                }
            }
            Step::Close => out.push(')'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(tag: &str, attrs: &[(&str, &str)], children: Vec<WNode>) -> WNode {
        let mut set = Attrs::new();
        for (key, value) in attrs {
            set.insert(key.to_string(), value.to_string());
        }
        WNode {
            tag: tag.to_string(),
            attrs: set,
            children,
        }
    }

    #[test]
    fn wexpr_text_is_what_the_typescript_serializer_writes() {
        let root = node(
            "module",
            &[("name", "m"), ("startIndex", "0")],
            vec![
                node(
                    "function",
                    &[("name", "say \"hi\"\n\tback\\slash\r")],
                    vec![],
                ),
                node(
                    "class",
                    &[("name", "C")],
                    vec![node("method", &[("doc", "été")], vec![])],
                ),
            ],
        );
        let omit = vec!["startIndex".to_string()];
        assert_eq!(
            serialize_wexpr(&root, &omit),
            r#"(module name="m" (function name="say \"hi\"\n\tback\\slash\r") (class name="C" (method doc="été")))"#
        );
        assert_eq!(serialize_wexpr(&node("leaf", &[], vec![]), &[]), "(leaf)");
    }

    fn python_mapping() -> LanguageMapping {
        serde_json::from_str(
            r#"{
              "name": "python", "extensions": [".py"],
              "nodeTypeMap": {"function_definition": "function", "class_definition": "class",
                              "import_statement": "import", "return_statement": "return"},
              "structuralTags": ["function", "class", "import", "return"],
              "nameExtractors": {"function_definition": "identifier", "class_definition": "identifier"},
              "maxDepth": 10
            }"#,
        )
        .expect("mapping parses")
    }

    #[test]
    fn methods_are_named_by_their_class_and_carry_signatures() {
        let source = "import os\n\nclass Store:\n    def get(self, key) -> str:\n        \"\"\"Read one.\"\"\"\n        return key\n";
        let options = EncodeOptions {
            docs: true,
            ..Default::default()
        };
        let encoded = encode_source(source, "python", &python_mapping(), &options)
            .expect("python is compiled in");
        let names: Vec<_> = encoded
            .symbols
            .iter()
            .map(|s| (s.kind.as_str(), s.name.as_str()))
            .collect();
        assert_eq!(names, vec![("class", "Store"), ("function", "Store.get")]);
        let get = &encoded.symbols[1];
        assert_eq!(get.signature.as_deref(), Some("Store.get(self, key):str"));
        assert_eq!(get.doc.as_deref(), Some("\"\"\"Read one.\"\"\""));
        assert_eq!(get.line, 4);
        assert!(!encoded.has_errors);
    }

    #[test]
    fn an_unknown_language_is_none_and_positions_are_utf16() {
        assert!(
            encode_source("x", "klingon", &python_mapping(), &EncodeOptions::default()).is_none()
        );
        let options = EncodeOptions {
            positions: true,
            ..Default::default()
        };
        let encoded = encode_source(
            "s = 'é😀'\ndef f():\n    pass\n",
            "python",
            &python_mapping(),
            &options,
        )
        .unwrap();
        let f = &encoded.root.children[0];
        // 'é' is one UTF-16 unit and '😀' two: `def` starts at UTF-16 offset 10 (byte offset 13).
        assert_eq!(f.attrs.get("startIndex").map(String::as_str), Some("10"));
    }
}
