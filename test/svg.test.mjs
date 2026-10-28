/**
 * The SVG validator (shared/svg.mjs) works on a parsed XML tree: one test per bypass class the
 * security review found against the old regex filter, plus the namespace, CSS and serialization
 * rules, and every shipped icon still passes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSvgSource } from "../shared/svg.mjs";
import { sanitizeArtifact, checkMermaidSource } from "../server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const svg = (inner, attrs = "") => `<svg viewBox="0 0 10 10"${attrs}>${inner}</svg>`;
const rejects = (source, re) => assert.throws(() => checkSvgSource(source), re, source);

test("(a) character references are decoded before url(), href and scheme checks", () => {
  rejects(svg('<rect fill="&#x75;rl(http://x/y)"/>'), /url\(\) in fill on <rect>: only url\(#id\)/);
  rejects(svg('<rect fill="&#117;&#114;&#108;(http://x/y)"/>'), /url\(\)/);
  rejects(svg('<use href="&#x68;ttp://x#y"/>'), /href on <use>: only #id/);
  rejects(svg('<use href="&#35;a&#x2f;b"/>'), /only #id/);
  rejects(svg('<rect style="fill:u&#x72;l(//x)"/>'), /url\(\)/);
  rejects(svg('<set attributeName="&#x68;ref" to="#a"/>'), /animation of href/);
  rejects(svg('<rect fill="javascript&#58;x"/>'), /javascript:/);
  rejects(svg('<style>.a{fill:&#x75;rl(http://x)}</style>'), /url\(\) in <style>/);
});

test("(b) CSS escapes and URL-taking functions other than url() are rejected", () => {
  rejects(svg('<rect style="fill:\\75 rl(http://x)"/>'), /CSS escapes/);
  rejects(svg("<style>.a{background:\\75 rl(http://x)}</style>"), /CSS escapes/);
  for (const fn of ['image-set("http://x" 1x)', 'image("http://x")', '-webkit-image-set("x" 1x)', 'cross-fade(url(#a), "x")', "element(#a)", "src(x)", "attr(data-x url)", "expression(alert(1))", "env(x)"])
    rejects(svg(`<style>.a{background:${fn}}</style>`), /function|javascript|expression/);
  rejects(svg('<style>@import "http://x/y.css";</style>'), /@import/);
  rejects(svg("<style>@font-face{font-family:a;src:local(x)}</style>"), /@font-face/);
  rejects(svg("<style>@namespace x url(http://x);</style>"), /@namespace/);
  rejects(svg('<rect fill="URL(http://x)"/>'), /url\(\)/);
  rejects(svg('<rect fill="url (http://x)"/>'), /write url\(#id\)/);
  rejects(svg('<rect fill="url(#a) url(http://x)"/>'), /url\(\)/);
  rejects(svg('<rect fill="url(&quot;http://x&quot;)"/>'), /url\(\)/);
  // What real diagrams use still works: colors, transforms, var(), light-dark(), @media, @keyframes, url(#id).
  const ok = checkSvgSource(
    svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="rgb(1,2,3)"/></linearGradient></defs>' +
        "<style>@media (min-width: 1px) and (max-width: 9px) { .a { fill: var(--c, light-dark(#fff, #000)) } } @keyframes k { from { opacity: 0 } }</style>" +
        '<rect class="a" fill="url(\'#g\')" transform="translate(1 2) rotate(30) scale(2)"/>',
    ),
  );
  assert.match(ok, /fill="url\('#g'\)"/);
});

test("(c) processing instructions are rejected, including ones whose name starts with xml", () => {
  rejects('<?xml-stylesheet href="http://x/y.css"?>' + svg(""), /processing instruction <\?xml-stylesheet\?>/);
  rejects(svg('<?xml-stylesheet href="x"?><rect/>'), /processing instruction/);
  rejects(svg("<?php echo 1 ?>"), /processing instruction/);
  // The XML declaration itself is fine and is dropped from the output.
  assert.equal(checkSvgSource('<?xml version="1.0" encoding="UTF-8"?>' + svg("<g/>")), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g/></svg>');
});

test("(d) CDATA, comments and odd element names cannot hide elements from the allowlist", () => {
  rejects(svg("<style><![CDATA[</style><image href='http://x'/>]]></style>"), /CDATA/);
  rejects(svg("<![CDATA[<script>alert(1)</script>]]>"), /CDATA/);
  rejects(svg("<!-- --><script>alert(1)</script>"), /unsafe SVG content: <script>/);
  rejects(svg("<style>/*</style><script>x</script>*/</style>"), /not well-formed XML|<script>/);
  rejects(svg("<style><g/></style>"), /<style> may contain only CSS text/);
  rejects(svg("<_script>x</_script>"), /unsupported SVG element <_script>/);
  rejects(svg('<svg:script xmlns:svg="http://www.w3.org/2000/svg">x</svg:script>'), /unsafe SVG content: <svg:script>/);
  rejects(svg("<scrİpt>x</scrİpt>"), /unsupported SVG element/);
  rejects(svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>'), /unsafe SVG content: <foreignObject>/);
  // Comments are dropped from the output.
  assert.equal(checkSvgSource(svg("<!-- note --><g/>")), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g/></svg>');
});

test("DOCTYPE, entities, namespaces and malformed XML are rejected", () => {
  // Entities declared in a DTD are never expanded: using one is a parse error.
  rejects('<!DOCTYPE svg [<!ENTITY x "y">]>' + svg("<text>&x;</text>"), /Named entity isn't defined: &x;/);
  rejects('<!DOCTYPE svg [<!ENTITY x "y">]>' + svg("<text/>"), /<!DOCTYPE> is not allowed/);
  rejects("<!DOCTYPE svg>" + svg(""), /<!DOCTYPE> is not allowed/);
  rejects(svg("<text>&bogus;</text>"), /not well-formed XML\): Named entity isn't defined/);
  rejects(svg('<g xmlns="http://www.w3.org/1999/xhtml"/>'), /xmlns must be "http:\/\/www.w3.org\/2000\/svg"/);
  rejects(svg("", ' xmlns="http://www.w3.org/1999/xhtml"'), /xmlns must be/);
  rejects(svg("", ' xmlns:xlink="http://www.w3.org/2000/svg"'), /xmlns:xlink must be/);
  rejects(svg("", ' xmlns:x="http://evil"'), /unsupported SVG attribute "xmlns:x"/);
  rejects(svg('<rect x:href="#a"/>'), /unsupported SVG attribute "x:href"/);
  rejects(svg('<rect width="1" width="2"/>'), /Duplicate attribute/);
  rejects(svg("<g>"), /not well-formed XML/);
  rejects(svg("") + "<svg/>", /not well-formed XML\): Extra content/);
  rejects("<html/>", /root element must be <svg>, not <html>/);
  rejects("<svg>" + "<g>".repeat(300) + "</g>".repeat(300) + "</svg>", /nests elements too deeply/);
  rejects("x".repeat(129 * 1024), /at most 128 KiB/);
  rejects(svg('<circle onload="alert(1)"/>'), /unsafe SVG attribute onload on <circle>/);
  rejects(svg('<circle ONCLICK="x"/>'), /unsafe SVG attribute ONCLICK/);
});

test("the output is re-serialized from the checked tree", () => {
  assert.equal(
    checkSvgSource("<svg viewBox='0 0 10 10'><text x='1'>a &lt; b &amp; c</text><use xlink:href='#a'/></svg>"),
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><text x="1">a &lt; b &amp; c</text><use xlink:href="#a"/></svg>',
  );
  // Visible text may say anything; only markup and CSS are checked.
  checkSvgSource(svg("<text>data: 5, javascript: no, url(x), @import</text>"));
  // An attribute value keeps exactly the characters the parser decoded.
  assert.match(checkSvgSource(svg('<text font-family="A &quot;B&quot;&#10;C">x</text>')), /font-family="A &quot;B&quot;&#10;C"/);
  // sanitizeArtifact stores the checked form.
  assert.equal(sanitizeArtifact({ type: "svg", source: svg("<rect width='1'></rect>") }).source, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1"/></svg>');
});

test("Mermaid init directives are rejected", () => {
  assert.throws(() => checkMermaidSource("%%{init: {'theme':'dark'}}%%\ngraph TD\n A-->B"), /%%\{\.\.\.\}%% directives are not allowed/);
  assert.throws(() => checkMermaidSource("graph TD\n %% { init: {} } %%\n A-->B"), /directives/);
  assert.equal(checkMermaidSource("graph TD\n %% a comment\n A-->B"), "graph TD\n %% a comment\n A-->B");
});

test("every shipped icon passes the validator", () => {
  const dir = path.join(ROOT, "public", "icons");
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));
  const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(files.length, index.length);
  assert.ok(files.length >= 1965, `${files.length} icons`);
  const failed = [];
  for (const file of files) {
    try {
      checkSvgSource(readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  assert.deepEqual(failed, []);
});
