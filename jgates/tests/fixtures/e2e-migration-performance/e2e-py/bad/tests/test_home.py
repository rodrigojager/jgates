from playwright.sync_api import Page, expect


def test_home_shows_store_name(page: Page) -> None:
    page.goto("/")
    expect(page.get_by_role("heading", level=1)).to_have_text("JGates Shop", timeout=3000)
