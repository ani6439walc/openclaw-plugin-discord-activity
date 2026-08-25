import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("jules_pr_review.py")
WORKFLOW = SCRIPT.parents[1] / "workflows" / "jules-pr-review.yml"

spec = importlib.util.spec_from_file_location("jules_pr_review", SCRIPT)
assert spec and spec.loader
jules_pr_review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jules_pr_review)


class JulesPrReviewTest(unittest.TestCase):
    def test_workflow_grants_contents_write_for_temporary_diff_branch(self):
        self.assertIn("  contents: write\n", WORKFLOW.read_text(encoding="utf-8"))

    def test_workflow_concurrency_group_is_per_pr(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("group: jules-pr-review-${{ github.event.pull_request.number }}\n", workflow_text)
        self.assertNotIn("group: jules-pr-review-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}", workflow_text)

    def test_workflow_author_association_allows_owner_member_collaborator(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('contains(fromJSON(\'["OWNER", "MEMBER", "COLLABORATOR"]\'), github.event.pull_request.author_association)', workflow_text)

    def test_workflow_includes_always_cleanup_step(self):
        workflow_text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("name: Cleanup temporary diff branch\n        if: always()", workflow_text)
        self.assertIn("git push origin --delete", workflow_text)

    def test_push_failure_reports_sanitized_git_output(self):
        github_token = "github-token-secret"
        jules_api_key = "jules-api-key-secret"
        error = subprocess.CalledProcessError(
            128,
            ["git", "push", "origin", "temp/pr-57-diff-1"],
            output=f"remote: rejected {github_token}",
            stderr=f"fatal: denied {jules_api_key}",
        )

        with mock.patch.dict(
            os.environ,
            {"GITHUB_TOKEN": github_token, "JULES_API_KEY": jules_api_key},
        ):
            with mock.patch.object(
                jules_pr_review.subprocess, "run", side_effect=error
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Failed to push temporary diff branch"
                ) as raised:
                    jules_pr_review.push_diff_branch("temp/pr-57-diff-1")

        message = str(raised.exception)
        self.assertIn("stdout: remote: rejected [REDACTED]", message)
        self.assertIn("stderr: fatal: denied [REDACTED]", message)
        self.assertNotIn(github_token, message)
        self.assertNotIn(jules_api_key, message)

    def test_request_wraps_network_error(self):
        import urllib.error
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("Connection refused")):
            with self.assertRaisesRegex(RuntimeError, "failed \\(network error\\)"):
                jules_pr_review.request("GET", "https://example.com")

    def test_ci_workflow_targets_main_and_runs_standard_checks(self):
        ci_workflow = SCRIPT.parents[1] / "workflows" / "ci.yml"
        self.assertTrue(ci_workflow.exists())
        ci_text = ci_workflow.read_text(encoding="utf-8")
        self.assertIn("branches: [main]", ci_text)
        self.assertIn("pnpm run typecheck", ci_text)
        self.assertIn("pnpm run test", ci_text)
        self.assertIn("pnpm run build", ci_text)


if __name__ == "__main__":
    unittest.main()