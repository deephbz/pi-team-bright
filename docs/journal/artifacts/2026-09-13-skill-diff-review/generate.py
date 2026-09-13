"""Compare the owner-approved draft with the current packaged skill.

The source skill is never written. Generated JSON, patch, and HTML are review
projections, not accepted skill policy.
"""
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
BASE = "d5ed077f1ddc1af2b76aa104e3938a6481c2e20d"
SKILL = "skills/pi-team-bright/SKILL.md"
PROPOSAL = "docs/journal/2026-09-13-skill-interface-rethink.md"

git_base = subprocess.check_output(["git", "show", f"{BASE}:{SKILL}"], cwd=REPO).decode()
blocks = re.findall(r"^```markdown\n(.*?)^```\s*$", (REPO / PROPOSAL).read_text(), re.M | re.S)
if len(blocks) != 1:
    raise SystemExit("Expected exactly one proposed Markdown skill in the review journal.")
old = blocks[0]
new = (REPO / SKILL).read_text()
assert old.startswith("---\nname: pi-team-bright\n")
assert new.startswith("---\nname: pi-team-bright\n")
old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
patch = "".join(difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{SKILL}", tofile=f"b/{SKILL}"))
counts = {"added": 0, "removed": 0}
for tag, i, j, a, b in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=False).get_opcodes():
    if tag in ("insert", "replace"):
        counts["added"] += b - a
    if tag in ("delete", "replace"):
        counts["removed"] += j - i

data = {
    "schema": "pi-team-bright-skill-review/1",
    "status": "working_copy_not_committed",
    "base": BASE,
    "comparison": "approved_draft_to_working_copy",
    "git_base_sha256": hashlib.sha256(git_base.encode()).hexdigest(),
    "path": SKILL,
    "proposal": PROPOSAL,
    "old": old,
    "new": new,
    "sha256": {"old": hashlib.sha256(old.encode()).hexdigest(), "new": hashlib.sha256(new.encode()).hexdigest()},
    "lines": {"old": len(old_lines), "new": len(new_lines)},
    "words": {"old": len(old.split()), "new": len(new.split())},
    **counts,
}
(ROOT / "public").mkdir(exist_ok=True)
(ROOT / "public" / "review.json").write_text(json.dumps(data, indent=2) + "\n")
(ROOT / "public" / "proposed.patch").write_text(patch)
print(json.dumps({key: value for key, value in data.items() if key not in ("old", "new")}))
