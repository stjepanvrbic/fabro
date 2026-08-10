pub use fabro_graphviz::static_reference::{
    AttributeScope, ReferenceKind, StaticReferenceError, reference_kind_for_attribute,
    validate_static_reference,
};

#[cfg(test)]
mod tests {
    use super::{AttributeScope, ReferenceKind, reference_kind_for_attribute};

    #[test]
    fn compatibility_reexport_remains_usable() {
        assert_eq!(
            reference_kind_for_attribute(AttributeScope::Node, "prompt", "@prompt.md"),
            Some(ReferenceKind::FileInline),
        );
    }
}
