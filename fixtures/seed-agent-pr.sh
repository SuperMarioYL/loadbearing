#!/usr/bin/env bash
# Seed a small repository that looks like an agent-authored PR: three files,
# six hunks, and a loadbearing.yml whose two probes observe only some of them.
#
# Usage: bash fixtures/seed-agent-pr.sh <target-dir>
#
# The committed HEAD~1..HEAD diff yields exactly:
#   3 necessary, 2 droppable, 1 unverifiable:no-probe
set -euo pipefail

target="${1:-}"
if [ -z "$target" ]; then
  echo "usage: $0 <target-dir>" >&2
  exit 2
fi
if [ "$target" = "/" ] || [ "$target" = "." ]; then
  echo "refusing to seed into $target" >&2
  exit 2
fi

rm -rf "$target"
mkdir -p "$target/src" "$target/test"
cd "$target"

git init -q
git config user.email "agent@example.com"
git config user.name "Example Agent"
git config commit.gpgsign false

cat > package.json <<'EOF'
{
  "name": "loadbearing-fixture",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "test": "node test/core.js && node test/app.js"
  }
}
EOF

cat > loadbearing.yml <<'EOF'
schema: loadbearing/config@1
probes:
  - name: core
    run: node test/core.js
    paths:
      - src/util.js
  - name: app
    run: node test/app.js
    paths:
      - src/app.js
EOF

cat > test/core.js <<'EOF'
'use strict';

const assert = require('node:assert');
const { greet, double, label } = require('../src/util.js');

assert.strictEqual(greet('ada'), 'hello ada', 'greet keeps the new greeting');
assert.strictEqual(double(21), 42, 'double still doubles');
assert.strictEqual(label(7), 'n:7', 'label keeps the new separator');

console.log('core probe ok');
EOF

cat > test/app.js <<'EOF'
'use strict';

const assert = require('node:assert');
const { total, scaled } = require('../src/app.js');

assert.strictEqual(total([1, 2, 3]), 6, 'total sums numbers');
assert.deepStrictEqual(scaled([1.4, 2.6]), [3, 5], 'scaled rounds');

console.log('app probe ok');
EOF

cat > src/util.js <<'EOF'
'use strict';

// Small helpers shared by the fixture probes.
//
// Each helper is exported from here; the agent changes one line per helper
// so a reviewer can see the revert-probe verdicts one at a time.

function greet(name) {
  return 'hi ' + name;
}

// Doubling is used by the scaled() probe in app.js.
// The probe only cares that the value doubles.

function double(n) {
  return n * 2;
}

// A label used by the core probe's assertions.
// The separator is asserted verbatim, so changing it is observable.

function label(n) {
  return 'n=' + n;
}

// Notes for the demo:
// - greet is asserted verbatim by test/core.js
// - label is asserted verbatim too
// - double is asserted through app.js
// - keep the exports at the bottom
//
// The padding below keeps the agent's additions in their own hunk instead
// of folding them into the label change above.
//
// Nothing in this block is executable; it only separates the changes so the
// fixture yields three hunks in this file rather than one folded hunk.
// That keeps the demo at six clusters.

module.exports = { greet, double, label };
EOF

cat > src/app.js <<'EOF'
'use strict';

const { double } = require('./util.js');

// Total is asserted by test/app.js.

function total(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}

// Notes for the demo:
// - total sums numbers; Number() is defensive and changes nothing the
//   probe can observe, so its hunk is droppable.
// - scaled pins rounding, so the pure double() version fails the probe
//   and its hunk is necessary.
// - keep both functions at the top level.
//
// The padding keeps the two changes in separate hunks instead of one.
// Nothing here is executable.
//
// More padding for the same reason: the fixture needs two hunks in this
// file, not one folded hunk.

function scaled(values) {
  return values.map((value) => double(value));
}

module.exports = { total, scaled };
EOF

cat > src/extra.js <<'EOF'
'use strict';

// No probe maps this file, so its hunk is unverifiable:no-probe.

function tag() {
  return 'base';
}

module.exports = { tag };
EOF

git add -A
git commit -q -m "chore: seed the fixture app"

# The agent's PR: three files, six hunks.
cat > src/util.js <<'EOF'
'use strict';

// Small helpers shared by the fixture probes.
//
// Each helper is exported from here; the agent changes one line per helper
// so a reviewer can see the revert-probe verdicts one at a time.

function greet(name) {
  return 'hello ' + name;
}

// Doubling is used by the scaled() probe in app.js.
// The probe only cares that the value doubles.

function double(n) {
  return n * 2;
}

// A label used by the core probe's assertions.
// The separator is asserted verbatim, so changing it is observable.

function label(n) {
  return 'n:' + n;
}

// Notes for the demo:
// - greet is asserted verbatim by test/core.js
// - label is asserted verbatim too
// - double is asserted through app.js
// - keep the exports at the bottom
//
// The padding below keeps the agent's additions in their own hunk instead
// of folding them into the label change above.
//
// Nothing in this block is executable; it only separates the changes so the
// fixture yields three hunks in this file rather than one folded hunk.
// That keeps the demo at six clusters.

function padLeft(text, width) {
  return text.padStart(width, ' ');
}

module.exports = { greet, double, label, padLeft };
EOF

cat > src/app.js <<'EOF'
'use strict';

const { double } = require('./util.js');

// Total is asserted by test/app.js.

function total(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return Number(sum);
}

// Notes for the demo:
// - total sums numbers; Number() is defensive and changes nothing the
//   probe can observe, so its hunk is droppable.
// - scaled pins rounding, so the pure double() version fails the probe
//   and its hunk is necessary.
// - keep both functions at the top level.
//
// The padding keeps the two changes in separate hunks instead of one.
// Nothing here is executable.
//
// More padding for the same reason: the fixture needs two hunks in this
// file, not one folded hunk.

function scaled(values) {
  return values.map((value) => Math.round(double(value)));
}

module.exports = { total, scaled };
EOF

cat > src/extra.js <<'EOF'
'use strict';

// No probe maps this file, so its hunk is unverifiable:no-probe.

function tag() {
  return 'agent';
}

module.exports = { tag };
EOF

git add -A
git commit -q -m "feat: agent tweaks the fixture app"

echo "seeded $target"
