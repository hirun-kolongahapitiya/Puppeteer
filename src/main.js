import { Actor, log } from 'apify';
import puppeteer from 'puppeteer';

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const { profiles = [] } = input;

    if (!profiles.length) {
        throw new Error(
            'No profiles provided. Example input: { "profiles": ["https://www.linkedin.com/in/username/"] }'
        );
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    log.info(`Profiles to visit: ${profiles.length}`);

    // ------------------ LOAD EXISTING SESSION ------------------
    const sessionStore = await Actor.openKeyValueStore('session');
    log.info(`Opened KV store: name=${sessionStore.name}, id=${sessionStore.id}`);

    let savedSession = await sessionStore.getValue('session.json');
    let cookies = savedSession?.cookies || [];
    let localStorageData = savedSession?.localStorageData || {};
    let sessionStorageData = savedSession?.sessionStorageData || {};

    if (savedSession) {
        log.info('Loaded existing session.json from KV store.');
    } else {
        log.warning('No session.json found. Login will be required.');
    }

    // ------------------ LAUNCH BROWSER ------------------
    log.info('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/119.0.0.0 Safari/537.36'
    );

    // Navigate once so we have correct domain
    await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded" });

    // ------------------ RESTORE SESSION IF AVAILABLE ------------------
    if (cookies.length) {
        log.info("Restoring cookies...");
        for (const cookie of cookies) {
            try {
                await page.setCookie(cookie);
            } catch (err) {
                log.warning(`Cookie error (${cookie.name}): ${err.message}`);
            }
        }
    }

    log.info("Restoring localStorage...");
    await page.evaluate((localData) => {
        for (const [k, v] of Object.entries(localData)) {
            localStorage.setItem(k, v);
        }
    }, localStorageData);

    log.info("Restoring sessionStorage...");
    await page.evaluate((sessData) => {
        for (const [k, v] of Object.entries(sessData)) {
            sessionStorage.setItem(k, v);
        }
    }, sessionStorageData);

    await sleep(2000);

    // Reload to apply restored session
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });

    // ------------------ CHECK IF LOGGED IN ------------------
    const isLoggedIn = await page.evaluate(() => {
        const title = document.title.toLowerCase();
        if (title.includes("sign in") || title.includes("join") || title.includes("sign up")) {
            return false;
        }
        return true;
    });

    // ------------------ LOG IN MANUALLY IF NOT LOGGED IN ------------------
    if (!isLoggedIn) {
        log.warning(`
        *************************************
        You are NOT logged in.
        👉 Open LIVE VIEW in Apify UI.
        👉 Complete LOGIN + 2FA manually.
        👉 After login, click around until feed loads.
        The actor will auto-detect login and continue.
        *************************************
        `);

        // Poll for login
        let loggedIn = false;
        while (!loggedIn) {
            await sleep(3000);
            loggedIn = await page.evaluate(() => {
                const title = document.title.toLowerCase();
                return !(title.includes("sign") || title.includes("join"));
            });
            log.info("Waiting for manual login via Live View...");
        }

        log.info("Manual login detected! Saving session.json...");

        // Extract fresh session
        const newCookies = await page.cookies();
        const newLocalStorage = await page.evaluate(() => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                data[k] = localStorage.getItem(k);
            }
            return data;
        });
        const newSessionStorage = await page.evaluate(() => {
            const data = {};
            for (let i = 0; i < sessionStorage.length; i++) {
                const k = sessionStorage.key(i);
                data[k] = sessionStorage.getItem(k);
            }
            return data;
        });

        // Save to KV store
        await sessionStore.setValue("session.json", {
            cookies: newCookies,
            localStorageData: newLocalStorage,
            sessionStorageData: newSessionStorage,
        });

        log.info("New session.json saved successfully!");
    } else {
        log.info("Session is still valid. No login needed.");
    }

    // ------------------ FOLLOW FUNCTION ------------------
    const clickFollow = async () => {
        return page.evaluate(() => {
            const normalize = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

            // Direct LinkedIn follow button selector
            let btn =
                document.querySelector("button[aria-label^='follow ' i]") ||
                document.querySelector("button span.artdeco-button__text");

            if (btn) {
                btn.scrollIntoView({ block: "center" });
                btn.click();
                return { clicked: true, aria: btn.getAttribute("aria-label"), text: btn.innerText };
            }

            return { clicked: false };
        });
    };

    // ------------------ PROCESS PROFILES ------------------
    for (const profileUrl of profiles) {
        log.info(`Visiting profile: ${profileUrl}`);

        await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
        await sleep(4000);

        const result = await clickFollow();
        log.info(`Follow result for ${profileUrl}: ${JSON.stringify(result)}`);
    }

    log.info("All done.");
    await browser.close();
    await Actor.exit();

} catch (err) {
    log.error(`FATAL ERROR: ${err?.stack || err}`);
    await Actor.fail(err.message || String(err));
}