import { Actor, Dataset, log } from 'apify';
import puppeteer from 'puppeteer';

// Simple sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Restore localStorage / sessionStorage from saved session.json
 */
async function restoreStorages(page, session) {
    if (!session) return;

    if (session.localStorageData) {
        await page.evaluate((data) => {
            try {
                Object.entries(data).forEach(([k, v]) => localStorage.setItem(k, v));
            } catch (e) {}
        }, session.localStorageData);
    }

    if (session.sessionStorageData) {
        await page.evaluate((data) => {
            try {
                Object.entries(data).forEach(([k, v]) => sessionStorage.setItem(k, v));
            } catch (e) {}
        }, session.sessionStorageData);
    }
}

/**
 * Robust LinkedIn login.
 */
async function ensureLogin(page, email, password) {
    log.info('Forcing LinkedIn login page…');

    await page
        .goto(
            'https://www.linkedin.com/login?fromSignIn=true&trk=guest_homepage-basic_nav-header-signin',
            { waitUntil: 'domcontentloaded', timeout: 150000 },
        )
        .catch(() => {});

    if (page.url().includes('authwall')) {
        log.warning('AuthWall detected — retrying plain login URL…');
        await page
            .goto('https://www.linkedin.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 150000,
            })
            .catch(() => {});
    }

    const emailSelectors = ['#username', "input[name='session_key']", 'input#session_key'];
    const passSelectors = ['#password', "input[name='session_password']", 'input#session_password'];

    let loginReady = false;

    for (let attempt = 0; attempt < 5; attempt++) {
        for (const sel of emailSelectors) {
            const el = await page.$(sel);
            if (el) {
                loginReady = true;
                break;
            }
        }
        if (loginReady) break;

        log.info(`Login form not ready (attempt ${attempt + 1}) — reloading login page…`);

        await sleep(2500);

        await page
            .goto('https://www.linkedin.com/login', {
                waitUntil: 'domcontentloaded',
                timeout: 150000,
            })
            .catch(() => {});
    }

    if (!loginReady) {
        throw new Error('LinkedIn login form not found — maybe CAPTCHA or account lock.');
    }

    const typeFirst = async (selectors, value) => {
        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await page.focus(sel);
                    // clear old value
                    await page.keyboard.down('Control').catch(() => {});
                    await page.keyboard.press('A').catch(() => {});
                    await page.keyboard.up('Control').catch(() => {});
                    await page.type(sel, value, { delay: 30 });
                    return true;
                }
            } catch (e) {}
        }
        return false;
    };

    await typeFirst(emailSelectors, email);
    await typeFirst(passSelectors, password);

    await Promise.all([
        page.click("button[type='submit']"),
        page
            .waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: 90000,
            })
            .catch(() => {}),
    ]);

    if (!page.url().includes('/feed')) {
        await page
            .goto('https://www.linkedin.com/feed/', {
                waitUntil: 'domcontentloaded',
                timeout: 90000,
            })
            .catch(() => {});
    }

    if (page.url().includes('checkpoint') || page.url().includes('challenge')) {
        throw new Error('LinkedIn requires verification (checkpoint / challenge).');
    }

    log.info('Login appears successful.');
}

/**
 * Clicks “Follow” on a profile.
 * - First: open the header “More actions” dropdown and try Follow there
 * - Fallback: main visible Follow button (button or [role="button"]) outside dropdown
 */
async function clickFollowButton(page) {
    // Small scroll to trigger lazy-loaded UI
    await page.evaluate(() => window.scrollBy(0, 300));
    await sleep(1200);

    //
    // 1) Open the correct "More actions" dropdown and tag it
    //
    const openedMore = await page.evaluate(() => {
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
            );
        };

        const selectors = [
            'button[aria-label="More actions"]',
            'button[aria-label*="More actions" i]',
            'button[id$="profile-overflow-action"]',
        ];

        for (const sel of selectors) {
            const btn = Array.from(document.querySelectorAll(sel)).find(isVisible);
            if (btn) {
                const dropdown = btn.closest('.artdeco-dropdown');
                if (dropdown) {
                    // mark this dropdown so we can find it later
                    dropdown.setAttribute('data-puppeteer-target', '1');
                }
                btn.click();
                return true;
            }
        }
        return false;
    });

    if (openedMore) {
        // Wait for dropdown panel to render
        await sleep(800);

        const clickedDropdown = await page.evaluate(() => {
            const dropdown = document.querySelector(
                '.artdeco-dropdown[data-puppeteer-target="1"]'
            );
            if (!dropdown) return false;

            const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.visibility !== 'hidden' &&
                    style.display !== 'none'
                );
            };

            // Any clickable item in THIS dropdown
            const items = Array.from(dropdown.querySelectorAll('[role="button"], button'));

            for (const el of items) {
                if (!isVisible(el)) continue;

                const label = (
                    el.innerText ||
                    el.getAttribute('aria-label') ||
                    ''
                ).trim().toLowerCase();

                if (label.includes('follow')) {
                    el.click();
                    return true;
                }
            }
            return false;
        });

        if (clickedDropdown) {
            return { clicked: true, via: 'dropdown' };
        }
    }

    //
    // 2) Fallback: main Follow button outside any dropdown
    //
    const { clickedMain, candidatesSample } = await page.evaluate(() => {
        const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
            );
        };

        const candidates = Array.from(
            document.querySelectorAll('button, [role="button"]')
        );

        const labelsForDebug = [];

        for (const el of candidates) {
            if (!isVisible(el)) continue;

            // ignore anything inside a dropdown panel
            if (el.closest('.artdeco-dropdown__content')) continue;

            const label = (
                el.innerText ||
                el.getAttribute('aria-label') ||
                ''
            ).trim();

            if (!label) continue;

            // collect a few labels for debugging
            if (labelsForDebug.length < 8) {
                labelsForDebug.push(label);
            }

            if (label.toLowerCase().includes('follow')) {
                el.click();
                return { clickedMain: true, candidatesSample: labelsForDebug };
            }
        }
        return { clickedMain: false, candidatesSample: labelsForDebug };
    });

    if (clickedMain) {
        return { clicked: true, via: 'main_button' };
    }

    // Extra debug info to console when nothing was found
    log.info(`No Follow button found. First UI labels seen: ${JSON.stringify(candidatesSample)}`);

    return { clicked: false, via: 'not_found' };
}


// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const { email, password, profiles = [] } = input;

    if (!profiles.length) throw new Error('No profiles provided in input.');

    // IMPORTANT:
    // - For the normal account use store "session"
    // - For Achini account, point this to "sessionachini"
    const store = await Actor.openKeyValueStore('sessionachini');
    let session = await store.getValue('sessionachini.json');

    const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 150000,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
        ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(150000);
    page.setDefaultTimeout(150000);

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    );

    // ---------------------------
    // TRY RESTORE SESSION FIRST
    // ---------------------------
    let loggedIn = false;

    if (session && session.cookies) {
        log.info('Restoring stored LinkedIn session for Achini…');

        for (const cookie of session.cookies) {
            try {
                await page.setCookie(cookie);
            } catch (e) {}
        }

        // first hit any LinkedIn page, then restore storages
        await page
            .goto('https://www.linkedin.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 150000,
            })
            .catch(() => {});
        await restoreStorages(page, session);

        await page
            .goto('https://www.linkedin.com/feed/', {
                waitUntil: 'domcontentloaded',
                timeout: 150000,
            })
            .catch((err) => {
                log.warning('Feed load failed after restoring session: ' + err.message);
            });

        if (page.url().includes('/feed')) {
            loggedIn = true;
            log.info('Sessionachini is valid – continuing without email/password.');
        } else {
            log.warning('Session appears invalid — will try email/password if provided.');
        }
    }

    // ---------------------------
    // LOGIN IF NEEDED
    // ---------------------------
    if (!loggedIn) {
        if (!email || !password) {
            throw new Error('Not logged in and no email/password provided in input.');
        }

        log.info('Logging in with email & password…');
        await ensureLogin(page, email, password);

        const cookies = await page.cookies();
        const localStorageData = await page.evaluate(() => {
            const o = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                o[key] = localStorage.getItem(key);
            }
            return o;
        });

        const sessionStorageData = await page.evaluate(() => {
            const o = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                o[key] = sessionStorage.getItem(key);
            }
            return o;
        });

        await store.setValue('sessionachini.json', {
            cookies,
            localStorageData,
            sessionStorageData,
        });
        log.info('Saved fresh session for Achini to KV store.');
    }

    // ---------------------------
    // PROCESS PROFILES
    // ---------------------------
    for (const url of profiles) {
        try {
            log.info(`Visiting profile: ${url}`);

            await page
                .goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 150000,
                })
                .catch((err) => {
                    log.warning('Profile load failed: ' + err.message);
                });

            await sleep(4000);

            // Save HTML snapshot for debugging
            const safeName = url.replace(/[^a-z0-9]+/gi, '_');
            const html = await page.content();
            const key = `debug-${Date.now()}-${safeName}.html`;
            await Actor.setValue(key, html, { contentType: 'text/html' });
            log.info(`Saved debug HTML as: ${key}`);

            const result = await clickFollowButton(page);
            log.info(`Follow result for ${url}: ${JSON.stringify(result)}`);

            await Dataset.pushData({
                profile: url,
                clicked: result.clicked,
                via: result.via,
                time: new Date().toISOString(),
            });

            await sleep(2500);
        } catch (err) {
            log.error(`Error on profile ${url}: ${err.message}`);
        }
    }

    await browser.close();
    await Actor.exit();
} catch (err) {
    log.error('FATAL ERROR: ' + err.message);
    await Actor.fail(err.message);
}
