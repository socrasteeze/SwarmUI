import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let browser = await chromium.launch();
try {
    for (let width of [360, 768, 1440]) {
        let page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.goto(pathToFileURL(path.resolve('src/BuiltinExtensions/TagDex/verify/library-harness.html')).href);
        await page.locator('.tagdex-library-character').click();
        await page.getByText('Add Variant').first().click();
        await page.locator('.tagdex-editor-dialog input').first().fill(`New ${width}`);
        await page.getByLabel('Archive Search').fill('Fixture');
        await page.waitForTimeout(350);
        await page.locator('.tagdex-editor-result button').click();
        await page.waitForTimeout(80);
        let weight = page.getByLabel('Weight');
        await weight.fill('0.7');
        await page.screenshot({ path: `.local/tagdex-shots/editor-${width}.png`, fullPage: true });
        await page.getByText('Save').last().click();
        await page.waitForTimeout(100);
        if (await page.locator('.tagdex-editor-dialog').count() != 0) {
            throw new Error(`Editor did not close at ${width}px.`);
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) {
            throw new Error(`Horizontal overflow at ${width}px.`);
        }
        if (width == 768) {
            await page.getByText('Add Variant').first().click();
            await page.locator('.tagdex-editor-dialog input').first().fill('Mixed');
            await page.getByLabel('Archive Search').fill('Fixture');
            await page.waitForTimeout(350);
            await page.locator('.tagdex-editor-result button').click();
            await page.waitForTimeout(80);
            await page.getByLabel('Archive Search').fill('Other');
            await page.waitForTimeout(350);
            await page.locator('.tagdex-editor-result button').click();
            await page.waitForTimeout(80);
            await page.getByText('Save').last().click();
            if (!await page.locator('.tagdex-editor-error').textContent().then(text => text.includes('incompatible'))) {
                throw new Error('Mixed-family stack was not rejected.');
            }
            await page.getByText('Cancel').last().click();
        }
        await page.screenshot({ path: `.local/tagdex-shots/library-${width}.png`, fullPage: true });
        await page.close();
    }
    console.log('TagDex library editor UI checks passed.');
}
finally {
    await browser.close();
}
