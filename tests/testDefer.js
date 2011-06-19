module("defer.jsm");

test("exports", function() {
	deepEqual(Object.keys(importModule("resource://dta/support/defer.jsm")), ["defer"], "Correct exports");
});

asyncTest("defer", function() {
	expect(1);
	var {defer} = importModule("resource://dta/support/defer.jsm");
	defer(function() {
		QUnit.start();
		ok("called");
	});
});

asyncTest("defer this", function() {
	expect(1);
	var {defer} = importModule("resource://dta/support/defer.jsm");
	var obj = {
			ok: false,
			fn: function() {
				QUnit.start();
				this.ok = true;
				equals(this.ok, obj.ok, "binding works");
			}
	};
	defer(obj.fn, obj);
});
