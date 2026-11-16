package web_test

// Shared string constants for the tests of this package. goconst counts the
// literals of the whole package, so a literal that three tests repeat fails
// Hub Go Static Checks. A new test reuses a constant from here, or adds one
// here, and never declares its own copy in a test file.
const (
	chatElsewhere = "elsewhere"
	chatWork      = "work"
	textHello     = "hello"
	titleOther    = "Other"
	todoRezero    = "rezero"

	fileToolCard   = "toolcard.js"
	keyDisplayMeta = "display_metadata"
	keyDurationMS  = "duration_ms"
	keyResultSize  = "result_size"
	keyToolOutcome = "tool_outcome"
)
