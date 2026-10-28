# MeshCrowd project website

A static site: plain HTML, CSS and JavaScript, no build step needed to view it, and no external resources
(no CDN, fonts or analytics). Open `index.html` in a browser or serve the folder with any web server.

```
index.html, features.html, download.html, gallery.html, about.html, license.html
LICENSE.txt            GNU GPL v3 text, linked from the licence page and footer
assets/css/site.css    all styling (colors follow the app; four switchable themes)
assets/js/site.js      shared header and footer, theme switch, tabs, lightbox, wiki chrome
assets/js/wiki-data.js generated search index for the wiki
assets/img, assets/video  screenshots and the two tour videos
wiki/                  generated wiki pages (do not edit by hand)
wiki-src/              the wiki as Markdown: edit these
build-wiki.mjs         turns wiki-src/*.md into wiki/*.html and wiki-data.js
```

## Editing the wiki

Edit or add a file in `wiki-src/` (front matter: `title`, `desc`, `group`, `order`), then run:

```
node Website/build-wiki.mjs
```

Supported Markdown: headings, paragraphs, lists, tables, fenced code, images (shown as screenshots),
`**bold**`, `*italic*`, `` `code` `` and links. Callouts use `::: note Title`, `::: warn Title` or
`::: danger Title` followed by `:::`.

## Languages

English lives in the site root and `wiki-src/`, Hungarian in `hu/` and `wiki-src/hu/`. Every page carries
`<link rel="alternate" hreflang="en|hu">` tags pointing at its counterpart. A tiny script in each `<head>`
and the EN/HU switch in the header use them:

- the first visit follows the browser language (`navigator.languages`): a Hungarian browser opening an
  English page is sent to the Hungarian one;
- the EN/HU switch stores the choice in `localStorage` (`mc-lang`), and an explicit choice beats detection;
- opening a direct link to the other language with no stored choice is allowed.

Shared UI text (menu, footer, wiki search) is in the `STR` table at the top of `assets/js/site.js`. To add a
language, add a folder like `hu/`, a `LANGS` entry in `build-wiki.mjs`, a `wiki-src/<code>/` folder and an
`STR` entry. In wiki Markdown, `## Heading {#id}` sets an explicit anchor, so links keep working across
languages. The app screenshots show the English interface in both languages.

## Download links

The buttons on `download.html` currently point to `#`. Replace the `href="#"` values when release files
have a home.

## Licence

The site is part of the project and uses the same licence (GNU GPL). Screenshots show a demo community
created for this purpose; no real user data appears in them.
