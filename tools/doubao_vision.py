#!/usr/bin/env python3
"""Doubao (豆包) web-account vision helper for dsh-ocr.

This tool owns the "登录豆包网页账户，用豆包视觉模型看图" path.  It drives
the real doubao.com chat page with Playwright and stores the logged-in browser
profile under $DOUBAO_PROFILE (default: $DSH_HOME/doubao/profile).

Commands:
  login                 open doubao.com, show/save the QR code, wait for scan
  status                check whether a logged-in profile exists
  logout                delete the stored browser profile
  ask --image FILE      upload one image to a new chat and return the reply

The Ark API backend (DOUBAO_ARK_API_KEY) is handled directly by the Node
plugin and does not need this script.

Environment:
  DOUBAO_PROFILE                 persistent browser profile directory
  DOUBAO_PLAYWRIGHT_BROWSERS_PATH  Playwright browser install directory
  DOUBAO_LOGIN_TIMEOUT_MS        QR login wait timeout (default 300000)
  DOUBAO_ASK_TIMEOUT_MS          answer wait timeout (default 180000)
  DOUBAO_HEADLESS                '0' forces headful when a display exists
  DOUBAO_DEBUG_SCREENSHOTS       '1' saves page screenshots into the profile dir
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Honour the dsh-ocr convention even when this tool is launched directly.
if os.environ.get("PLAYWRIGHT_BROWSERS_PATH") in (None, "") and os.environ.get("DOUBAO_PLAYWRIGHT_BROWSERS_PATH"):
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.environ["DOUBAO_PLAYWRIGHT_BROWSERS_PATH"]

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:  # pragma: no cover - helpful error without deps
    print(json.dumps({
        "ok": False,
        "error": f"playwright is not installed: {exc}. "
                 "Install it with: pip install playwright && playwright install chromium",
    }, ensure_ascii=False))
    raise SystemExit(3)

CHAT_URL = "https://www.doubao.com/chat/"
LOGIN_BUTTON_SELECTOR = "button.login-btn-header-CTKsn1"
LOGIN_BUTTON_FALLBACK = "button:has-text('登录')"
QR_SVG_SELECTOR = "svg[shape-rendering='crispEdges']"
FILE_INPUT_SELECTOR = "input[type='file']"
TEXTAREA_SELECTOR = "textarea.semi-input-textarea"
PLUS_SVG_PREFIX = "M12.0005 2.25"


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value not in ("0", "false", "False", "no", "")


def resolve_profile():
    explicit = os.environ.get("DOUBAO_PROFILE")
    if explicit:
        return Path(explicit).expanduser().resolve()
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        base = Path(dsh_home).expanduser().resolve()
    else:
        base = Path.home() / ".dsh"
    return base / "doubao" / "profile"


def json_out(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def browser_kwargs(profile):
    kwargs = {
        "user_data_dir": str(profile),
        "headless": True,
        "viewport": {"width": 1440, "height": 900},
        "locale": "zh-CN",
        "timezone_id": "Asia/Shanghai",
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    }
    if os.environ.get("DOUBAO_HEADLESS") not in (None, "", "1", "true", "True"):
        kwargs["headless"] = False
    return kwargs


def apply_stealth(browser_context):
    try:
        browser_context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); "
            "window.chrome = window.chrome || { runtime: {} };"
        )
    except Exception:
        pass


def close_announcement(page):
    try:
        button = page.locator("button[aria-label='关闭']")
        if button.count() > 0:
            button.first.click(timeout=1500)
            page.wait_for_timeout(600)
    except Exception:
        pass


def goto_chat(page, wait_ms=5000):
    page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(wait_ms)
    close_announcement(page)


def logged_in(page):
    # The header login button disappears after a successful login.
    try:
        if page.locator(LOGIN_BUTTON_SELECTOR).count() == 0:
            return True
    except Exception:
        pass
    try:
        # When the modal is not open, an exact "登录" button means logged out.
        if page.get_by_role("button", name="登录", exact=True).count() == 0:
            return True
    except Exception:
        pass
    return False


def save_qr(page, profile):
    profile.mkdir(parents=True, exist_ok=True)
    qr_path = profile.parent / "doubao-login-qr.png"
    try:
        qr = page.locator(QR_SVG_SELECTOR).first
        qr.scroll_into_view_if_needed(timeout=2000)
        qr.screenshot(path=str(qr_path), timeout=5000)
        return qr_path
    except Exception as exc:
        log(f"[doubao] QR screenshot failed ({exc}); saving whole page instead")
        page.screenshot(path=str(qr_path), full_page=True)
        return qr_path


def open_login(page, profile):
    if logged_in(page):
        return True
    try:
        page.locator(LOGIN_BUTTON_SELECTOR).first.click(timeout=5000)
    except Exception:
        try:
            page.get_by_role("button", name="登录", exact=True).first.click(timeout=5000)
        except Exception as exc:
            raise RuntimeError(f"cannot open login dialog: {exc}") from exc
    page.wait_for_timeout(2500)
    if page.locator(QR_SVG_SELECTOR).count() == 0:
        raise RuntimeError("login QR code not found; doubao.com may have changed its login UI")
    qr_path = save_qr(page, profile)
    if env_bool("DOUBAO_DEBUG_SCREENSHOTS"):
        page.screenshot(path=str(profile.parent / "doubao-login-page.png"), full_page=True)
    return qr_path


def wait_for_login(page, timeout_ms):
    deadline = time.monotonic() + timeout_ms / 1000
    try:
        page.locator(LOGIN_BUTTON_SELECTOR).first.wait_for(
            state="detached", timeout=timeout_ms)
        page.wait_for_timeout(3000)  # let storage flush
        return True
    except Exception:
        return logged_in(page)
    finally:
        _ = deadline


def cmd_login(profile):
    profile.mkdir(parents=True, exist_ok=True)
    timeout_ms = int(os.environ.get("DOUBAO_LOGIN_TIMEOUT_MS", "300000"))
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(**browser_kwargs(profile))
        try:
            apply_stealth(browser)
            page = browser.pages[0] if browser.pages else browser.new_page()
            goto_chat(page)
            if logged_in(page):
                json_out({"ok": True, "loggedIn": True, "profile": str(profile)})
                return 0
            qr_path = open_login(page, profile)
            log("豆包登录二维码已保存到:", qr_path)
            log("请使用 豆包/抖音/飞书 App 扫码登录，等待登录完成...")
            if wait_for_login(page, timeout_ms):
                json_out({"ok": True, "loggedIn": True, "profile": str(profile), "qr": str(qr_path)})
                return 0
            json_out({"ok": False, "loggedIn": False, "profile": str(profile),
                      "qr": str(qr_path), "error": "login timed out"})
            return 4
        finally:
            browser.close()


def cmd_logout(profile):
    if not profile.exists():
        json_out({"ok": True, "removed": False, "profile": str(profile)})
        return 0
    import shutil
    shutil.rmtree(profile, ignore_errors=True)
    json_out({"ok": True, "removed": True, "profile": str(profile)})
    return 0


def cmd_status(profile):
    if not profile.exists():
        json_out({"ok": True, "loggedIn": False, "profile": str(profile),
                  "error": "profile not found; run login first"})
        return 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(**browser_kwargs(profile))
            try:
                apply_stealth(browser)
                page = browser.pages[0] if browser.pages else browser.new_page()
                goto_chat(page, wait_ms=3500)
                ok = logged_in(page)
                json_out({"ok": True, "loggedIn": ok, "profile": str(profile),
                          "url": page.url})
                return 0
            finally:
                browser.close()
    except Exception as exc:
        json_out({"ok": False, "loggedIn": False, "profile": str(profile), "error": str(exc)})
        return 1


def click_plus(page):
    plus = page.locator("button").filter(has=page.locator(f"svg path[d^='{PLUS_SVG_PREFIX}']"))
    if plus.count() == 0:
        raise RuntimeError("attachment '+' button not found; doubao.com UI may have changed")
    chosen = None
    try:
        textarea = page.locator(TEXTAREA_SELECTOR).first
        box = textarea.bounding_box()
        if box is not None:
            for i in range(plus.count()):
                candidate = plus.nth(i)
                candidate_box = candidate.bounding_box()
                if candidate_box is not None and candidate_box["y"] >= box["y"] - 20:
                    chosen = candidate
                    break
    except Exception:
        chosen = None
    if chosen is None:
        chosen = plus.last
    chosen.click(timeout=5000)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if page.locator(FILE_INPUT_SELECTOR).count() > 0:
            return page.locator(FILE_INPUT_SELECTOR).first
        page.wait_for_timeout(300)
    raise RuntimeError("file input did not appear after clicking '+'")


def upload_image(page, image_path):
    file_input = click_plus(page)
    file_input.set_input_files(str(image_path), timeout=30_000)
    # The input is removed once the upload has been registered; wait for that
    # state (or for an explicit image hint) so typing does not race upload.
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if page.locator(FILE_INPUT_SELECTOR).count() == 0:
            page.wait_for_timeout(1200)
            return
        if page.get_by_text("解释图片").count() > 0:
            page.wait_for_timeout(1200)
            return
        page.wait_for_timeout(500)
    log("[doubao] upload-complete wait timed out; continuing anyway")


def body_text(page):
    try:
        return page.locator("body").inner_text(timeout=3000)
    except Exception:
        return ""


def wait_for_answer(page, baseline, timeout_ms):
    """Wait until the explanation flow adds a substantial answer."""
    deadline = time.monotonic() + timeout_ms / 1000
    last = baseline
    stable = 0.0
    changed = False
    while time.monotonic() < deadline:
        page.wait_for_timeout(2000)
        try:
            if page.locator("#captcha_container").count() > 0:
                return
        except Exception:
            pass
        current = body_text(page)
        if current != baseline:
            changed = True
        if changed and current == last:
            stable += 2
            if stable >= 10:
                return
        else:
            stable = 0.0
            last = current
    log("[doubao] answer wait timed out")


def extract_answer(page):
    """Pick the longest text block rendered in the chat main area."""
    best = ""
    try:
        for selector in ["div", "section", "article", "p", "span", "li"]:
            loc = page.locator(selector)
            for i in range(loc.count()):
                try:
                    el = loc.nth(i)
                    box = el.bounding_box()
                    if box is None or box["x"] < 330 or box["x"] > 1400 or box["y"] < 90 or box["y"] > 820:
                        continue
                    text = el.inner_text(timeout=1200).strip()
                    if len(text) > len(best):
                        best = text
                except Exception:
                    continue
    except Exception:
        pass
    if best:
        return best
    # Last-resort whole-body fallback.
    current = body_text(page)
    idx = current.find("AI 生成可能有误")
    if idx >= 0:
        current = current[idx:]
    return current.strip()[:12000]


def cmd_ask(profile, image_path, prompt, timeout_ms):
    if not profile.exists():
        json_out({"ok": False, "error": "Doubao profile not found; run `python tools/doubao_vision.py login` first"})
        return 2
    image_path = Path(image_path).expanduser().resolve()
    if not image_path.exists():
        json_out({"ok": False, "error": f"image not found: {image_path}"})
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(**browser_kwargs(profile))
        try:
            apply_stealth(browser)
            page = browser.pages[0] if browser.pages else browser.new_page()
            goto_chat(page)
            if not logged_in(page):
                json_out({"ok": False, "error": "Doubao web session is not logged in; run login first"})
                return 3

            # Upload and prefer Doubao's own one-click "解释图片" flow.
            upload_image(page, image_path)
            baseline = body_text(page)
            chip = page.get_by_text("解释图片", exact=True)
            if chip.count() > 0:
                chip.last.click(timeout=8000)
                page.wait_for_timeout(2500)
                if page.locator("#captcha_container").count() > 0:
                    page.screenshot(path=str(profile.parent / "doubao-ask-captcha.png"), full_page=True)
                    json_out({"ok": False, "captcha": True,
                              "error": "Doubao web CAPTCHA required. Solve it interactively in a desktop browser once; "
                                       "or use DOUBAO_MODE=ark with DOUBAO_ARK_API_KEY."})
                    return 7
                wait_for_answer(page, baseline, timeout_ms)
                answer = extract_answer(page)
                if not answer:
                    json_out({"ok": False, "error": "no answer text extracted; doubao.com UI may have changed"})
                    return 5
                json_out({"ok": True, "text": answer, "url": page.url})
                return 0

            # Fallback path when the one-click chip is absent: send the prompt manually.
            textarea = page.locator(TEXTAREA_SELECTOR).first
            textarea.fill(prompt, timeout=10_000)
            page.wait_for_timeout(400)
            try:
                page.keyboard.press("Enter")
            except Exception:
                pass
            wait_for_answer(page, baseline, timeout_ms)
            answer = extract_answer(page)
            if not answer:
                json_out({"ok": False, "error": "no answer text extracted; doubao.com UI may have changed"})
                return 5
            json_out({"ok": True, "text": answer, "url": page.url})
            return 0
        except Exception as exc:
            if env_bool("DOUBAO_DEBUG_SCREENSHOTS"):
                try:
                    page.screenshot(path=str(profile.parent / "doubao-ask-error.png"), full_page=True)
                except Exception:
                    pass
            json_out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return 6
        finally:
            browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login", help="open doubao.com, save QR code, wait for login")
    sub.add_parser("logout", help="delete the stored Doubao browser profile")
    sub.add_parser("status", help="check whether the stored profile is logged in")
    ask = sub.add_parser("ask", help="upload one image and return Doubao's answer")
    ask.add_argument("--image", required=True, help="image file path")
    ask.add_argument("--prompt", default="请详细描述这张图片。", help="prompt for the vision model")
    ask.add_argument("--timeout", type=int, default=180, help="answer timeout in seconds")
    ask.add_argument("--json", action="store_true", help="print JSON (the Node plugin passes this)")
    args = parser.parse_args()

    profile = resolve_profile()
    if args.command == "login":
        return cmd_login(profile)
    if args.command == "logout":
        return cmd_logout(profile)
    if args.command == "status":
        return cmd_status(profile)
    if args.command == "ask":
        return cmd_ask(profile, args.image, args.prompt, int(args.timeout) * 1000)
    parser.error(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
