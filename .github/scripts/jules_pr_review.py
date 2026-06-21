#!/usr/bin/env python3
import json
import os
import time
import urllib.error
import urllib.request

JULES_API = "https://jules.googleapis.com/v1alpha"
GITHUB_API = "https://api.github.com"

# States where Jules has produced a review we can extract.
REVIEWABLE_STATES = {
    "COMPLETED",
    "AWAITING_USER_FEEDBACK",
    "AWAITING_PLAN_APPROVAL",
    "PAUSED",
}
FINAL_STATES = REVIEWABLE_STATES | {"FAILED"}
MAX_DIFF_CHARS = 180_000
MAX_COMMENT_CHARS = 60_000
POLL_SECONDS = 15
MAX_POLLS = 100  # 25 minutes total
TRANSIENT_ATTEMPTS = 3
TRANSIENT_DELAY_SECONDS = 5
REVIEW_MARKER = "<!-- jules-pr-review -->"


def log(msg):
    print(f"[jules-review] {msg}", flush=True)


def request(method, url, headers=None, body=None):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers or {},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            content_type = resp.headers.get("content-type", "")
            text = raw.decode("utf-8", errors="replace")
            if "application/json" in content_type:
                return json.loads(text) if text else {}
            return text
    except urllib.error.HTTPError as exc:
        msg = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: {exc.code} {msg}") from exc


def request_with_retry(method, url, headers=None, body=None):
    last_error = None
    for attempt in range(1, TRANSIENT_ATTEMPTS + 1):
        try:
            return request(method, url, headers, body)
        except RuntimeError as exc:
            last_error = exc
            if attempt == TRANSIENT_ATTEMPTS:
                break
            log(
                f"Transient request failure ({attempt}/{TRANSIENT_ATTEMPTS}); "
                f"retrying in {TRANSIENT_DELAY_SECONDS}s: {exc}"
            )
            time.sleep(TRANSIENT_DELAY_SECONDS)
    raise last_error or RuntimeError(f"{method} {url} failed after retries")


def github_headers(accept="application/vnd.github+json"):
    return {
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jules-pr-review-action",
    }


def jules_headers():
    return {
        "X-Goog-Api-Key": os.environ["JULES_API_KEY"],
        "Content-Type": "application/json",
        "User-Agent": "jules-pr-review-action",
    }


def get_pr_diff(owner, repo, pr_number):
    url = f"{GITHUB_API}/repos/{owner}/{repo}/pulls/{pr_number}"
    return request("GET", url, github_headers("application/vnd.github.v3.diff"))


def create_jules_session(owner, repo, diff_text):
    pr_number = os.environ["PR_NUMBER"]
    title = os.environ.get("PR_TITLE", "")
    base_ref = os.environ["BASE_REF"]
    head_sha = os.environ["HEAD_SHA"]
    pr_url = os.environ["PR_URL"]

    truncated = len(diff_text) > MAX_DIFF_CHARS
    diff_for_prompt = diff_text[:MAX_DIFF_CHARS]
    truncation_note = ""
    if truncated:
        truncation_note = f"""

## Diff Truncation Notice
The diff is {len(diff_text):,} characters and was truncated to {MAX_DIFF_CHARS:,} characters for this automated review. Review only the included excerpt and explicitly call out that additional context may be needed for complete confidence.
"""

    prompt = f"""You are a senior staff engineer performing a thorough code review. You focus on correctness, security, regressions, test coverage, maintainability, and backwards compatibility.

## Context
- Repo: {owner}/{repo}
- PR: #{pr_number} — {title}
- Base: {base_ref} → Head: {head_sha}
- URL: {pr_url}
- Diff fully provided: {not truncated}
{truncation_note}
## Constraints
- Review-only mode. Do NOT create plans, modify files, or open PRs.
- Base your review solely on the diff below.

## Review Dimensions
Evaluate the diff across these aspects:
- Correctness, security, regressions, test coverage, maintainability, backwards compatibility.
- Complexity, naming, comments, documentation, and consistency with the existing codebase.

## Output Format
Return a Markdown review using this exact structure:

### Summary
One paragraph: what this PR does and overall impression.

### 🔴 Blocking Issues
List each blocking issue with: file, line range, problem description, and suggested fix.
Blocking = correctness bugs, security vulnerabilities, data loss risks, broken backwards compatibility.
If none, write: "No blocking issues found."

### 🟡 Suggestions
List each non-blocking suggestion with: file, line range, and improvement idea.
If none, write: "No additional suggestions."

### 🧪 Tests & Verification
List any missing test scenarios or verification steps the author should perform.
If tests are adequate, write: "Test coverage looks good."

### Verdict
One of: ✅ Approve | ⚠️ Approve with comments | ❌ Request changes
One sentence justification.

<diff>
{diff_for_prompt}
</diff>
"""

    payload = {
        "prompt": prompt,
        "title": f"Review PR #{pr_number}: {title}"[:120],
        "sourceContext": {
            "source": f"sources/github/{owner}/{repo}",
            "githubRepoContext": {
                "startingBranch": base_ref,
            },
        },
        "requirePlanApproval": False,
    }

    return request("POST", f"{JULES_API}/sessions", jules_headers(), payload)


def get_jules_session(session_name):
    return request_with_retry("GET", f"{JULES_API}/{session_name}", jules_headers())


def get_jules_activities(session_name):
    return request_with_retry(
        "GET",
        f"{JULES_API}/{session_name}/activities",
        jules_headers(),
    )


def pause_jules_session(session_name):
    log(f"Pausing session {session_name}...")
    try:
        request("POST", f"{JULES_API}/{session_name}:pause", jules_headers(), {})
        log("Session paused.")
    except Exception as e:
        log(f"Pause failed (non-fatal): {e}")


def archive_jules_session(session_name):
    log(f"Archiving session {session_name}...")
    try:
        request("POST", f"{JULES_API}/{session_name}:archive", jules_headers(), {})
        log("Session archived.")
    except Exception as e:
        log(f"Archive failed (non-fatal): {e}")


def extract_review_from_activities(activities_response):
    activities = activities_response.get("activities", [])
    messages = []

    for activity in activities:
        agent = activity.get("agentMessaged") or {}
        text = agent.get("agentMessage")
        if text:
            messages.append(text.strip())

    if not messages:
        return None

    return messages[-1]


def has_complete_review(activities_response):
    activities = activities_response.get("activities", [])

    for activity in activities:
        agent = activity.get("agentMessaged") or {}
        text = agent.get("agentMessage") or ""

        if REVIEW_MARKER in text:
            return True

        text_lower = text.lower()
        has_summary = "summary" in text_lower
        has_blocking = "blocking" in text_lower or "issues" in text_lower
        has_recommendation = "recommendation" in text_lower or "verdict" in text_lower

        if has_summary and (has_blocking or has_recommendation):
            return True

    return False


def post_pr_comment(owner, repo, pr_number, body):
    body = body.strip()
    if len(body) > MAX_COMMENT_CHARS:
        body = (
            body[:MAX_COMMENT_CHARS]
            + "\n\n_Review truncated because it exceeded GitHub comment size limits._"
        )

    comment = f"""{REVIEW_MARKER}
## Jules PR Review

{body}

---
_Reviewed by Jules via GitHub Actions._
"""

    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{pr_number}/comments"
    return request("POST", url, github_headers(), {"body": comment})


def fail_pr_comment(owner, repo, pr_number, message):
    body = f"""<!-- jules-pr-review -->
## Jules PR Review failed

{message}

---
_The Jules review workflow could not complete._
"""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{pr_number}/comments"
    request("POST", url, github_headers(), {"body": body})


def main():
    owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
    pr_number = os.environ["PR_NUMBER"]

    log(f"Fetching diff for PR #{pr_number}...")
    diff_text = get_pr_diff(owner, repo, pr_number)
    if not diff_text.strip():
        log("No diff found, posting comment and exiting.")
        post_pr_comment(owner, repo, pr_number, "No diff was found for this pull request.")
        return

    log(f"Diff size: {len(diff_text):,} chars, creating Jules session...")
    session = create_jules_session(owner, repo, diff_text)
    session_name = session["name"]
    session_url = session.get("url", "")
    initial_state = session.get("state", "UNKNOWN")

    log(f"Session created: {session_name}")
    log(f"State: {initial_state}")
    if session_url:
        log(f"URL: {session_url}")

    final_session = session
    state = session.get("state", "UNKNOWN")
    early_exit = False
    for poll_num in range(1, MAX_POLLS + 1):
        time.sleep(POLL_SECONDS)
        final_session = get_jules_session(session_name)
        state = final_session.get("state", "UNKNOWN")

        if poll_num % 4 == 1 or state in FINAL_STATES:
            log(f"Poll {poll_num}/{MAX_POLLS}: state={state}")

        if state in FINAL_STATES:
            log(f"Session reached final state: {state}")
            try:
                activities = get_jules_activities(session_name)
                if has_complete_review(activities):
                    log("Review detected in activities — pausing and archiving session")
                    pause_jules_session(session_name)
                    archive_jules_session(session_name)
                    early_exit = True
            except Exception as e:
                log(f"Could not check activities: {e}")
            break

        if state == "IN_PROGRESS":
            try:
                activities = get_jules_activities(session_name)
                if has_complete_review(activities):
                    log("Review detected in activities during IN_PROGRESS — pausing and archiving session")
                    pause_jules_session(session_name)
                    archive_jules_session(session_name)
                    early_exit = True
                    break
            except Exception as e:
                log(f"Could not check activities: {e}")

    if not early_exit and state not in FINAL_STATES:
        log(f"Timed out after {MAX_POLLS * POLL_SECONDS}s")
        fail_pr_comment(
            owner,
            repo,
            pr_number,
            f"Timed out waiting for Jules session after {MAX_POLLS * POLL_SECONDS // 60} minutes.\n\nLast state: `{final_session.get('state')}`\n\nSession: {session_url}",
        )
        raise SystemExit(1)

    state = final_session.get("state")
    log("Fetching activities for session...")
    activities = get_jules_activities(session_name)
    activity_count = len(activities.get("activities", []))
    log(f"Found {activity_count} activities")

    if not early_exit and state not in REVIEWABLE_STATES:
        reason = json.dumps(final_session, indent=2, ensure_ascii=False)
        fail_pr_comment(
            owner,
            repo,
            pr_number,
            f"Jules session ended with non-reviewable state `{state}`.\n\nSession: {session_url}\n\n```json\n{reason[:4000]}\n```",
        )
        raise SystemExit(1)

    review = extract_review_from_activities(activities)
    if review is None:
        review = "Jules completed, but no review message was found in session activities."

    if session_url:
        review += f"\n\nJules session: {session_url}"

    log(f"Posting review comment ({len(review):,} chars)...")
    post_pr_comment(owner, repo, pr_number, review)
    log("Done!")


if __name__ == "__main__":
    main()
