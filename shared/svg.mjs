/**
 * The SVG validator behind every SVG artifact (and, at build time, the icon library).
 *
 * The board shows SVG only through an <image> data URI, where browsers run no scripts and load
 * nothing from outside: that is the real control. This validator is the second layer, so it has
 * to agree with what a browser's XML parser sees. It therefore works on a parsed tree, never on
 * the raw text:
 *
 *   1. parse with a strict XML parser (@rgrove/parse-xml: no DTD processing, no custom entities);
 *      anything that is not well-formed XML is rejected with the parser's message;
 *   2. reject DOCTYPE, processing instructions and CDATA (the XML declaration is dropped);
 *   3. walk the elements: names must be in SVG_TAGS exactly (no prefixes, no other namespace),
 *      attribute names in SVG_ATTRS exactly, xmlns and xmlns:xlink only with their standard URIs;
 *   4. check every decoded attribute value and every <style> text: no backslash (CSS escapes), no
 *      javascript:, vbscript: or data: URLs, no at-rules except @keyframes and @media, and no
 *      functions except a fixed list of color, math and transform functions plus url(#id);
 *      href and xlink:href must be "#id"; SMIL may not animate href;
 *   5. re-serialize from the tree, so what is stored and displayed is exactly what was checked.
 *
 * Errors name the offending element, attribute or construct.
 */
import { parseXml } from "@rgrove/parse-xml";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const XLINK_NS = "http://www.w3.org/1999/xlink";
export const MAX_SVG_BYTES = 128 * 1024;
const MAX_DEPTH = 200;

export const SVG_TAGS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "style",
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan", "textPath",
  "marker", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
  // SMIL animation runs inside SVG images without scripts.
  "animate", "animateTransform", "animateMotion", "mpath", "set",
]);
export const SVG_ATTRS = new Set([
  "xmlns", "xmlns:xlink", "version", "id", "class", "style", "width", "height", "viewBox", "preserveAspectRatio",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "dx", "dy", "d", "points", "pathLength",
  "transform", "opacity", "visibility", "display",
  "fill", "fill-opacity", "fill-rule", "clip-rule", "clip-path", "mask",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "vector-effect",
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration", "textLength", "lengthAdjust", "rotate", "startOffset", "writing-mode",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits",
  "href", "xlink:href", "color",
  "attributeName", "attributeType", "from", "to", "by", "values", "dur", "begin", "end", "repeatCount", "repeatDur", "restart",
  "keyTimes", "keySplines", "keyPoints", "calcMode", "additive", "accumulate", "type", "path", "min", "max",
]);
/** Elements that can run script, embed documents or load resources: named as unsafe, not just unsupported. */
const UNSAFE_TAGS = /^(script|foreignobject|image|iframe|object|embed|a|feimage|handler|listener|audio|video|font-face|font-face-uri)$/i;
/**
 * CSS functions allowed in attribute values and <style> (compared in ASCII lowercase): colors, math,
 * transforms, timing and basic shapes. Anything else that looks like a function (src(), image-set(),
 * cross-fade(), element(), attr(), expression() ...) is rejected, so no URL-taking function remains.
 */
const CSS_FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "light-dark",
  "calc", "min", "max", "clamp", "var",
  "translate", "translatex", "translatey", "translate3d", "scale", "scalex", "scaley", "scale3d",
  "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy", "matrix", "matrix3d", "perspective",
  "cubic-bezier", "steps", "linear", "inset", "circle", "ellipse", "polygon", "rect",
]);
const AT_RULES = new Set(["keyframes", "-webkit-keyframes", "media"]);
const ID_REF = /^#[A-Za-z_][\w.-]*$/;
const URL_ID = /^url\(\s*(['"]?)#[A-Za-z_][\w.-]*\1\s*\)/;

const fail = (message) => {
  throw new Error(message);
};

/**
 * Check CSS-capable text (an attribute value or a <style> block) after XML decoding.
 * `where` names it in the error.
 */
function checkCss(value, where) {
  if (value.includes("\\")) fail(`unsafe SVG content in ${where}: CSS escapes (\\) are not allowed`);
  const lower = value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const scheme = /javascript:|vbscript:|data:|expression\s*\(/.exec(lower);
  if (scheme) fail(`unsafe SVG content in ${where}: ${scheme[0]}`);
  for (const m of lower.matchAll(/@(-?[a-z][a-z0-9-]*)/g))
    if (!AT_RULES.has(m[1])) fail(`unsafe SVG content in ${where}: @${m[1]} (only @keyframes and @media are allowed)`);
  // A CSS function is a name immediately followed by "(" ("url (" is no function, but is refused too).
  if (/\burl\s+\(/.test(lower)) fail(`unsafe SVG url() in ${where}: write url(#id)`);
  for (const m of lower.matchAll(/(-?[a-z_][a-z0-9_-]*)\(/g)) {
    const name = m[1];
    if (name === "url") {
      if (!URL_ID.test(lower.slice(m.index))) {
        const shown = value.slice(m.index, value.indexOf(")", m.index) + 1 || m.index + 40).slice(0, 80);
        fail(`unsafe SVG url() in ${where}: only url(#id) is allowed, got ${shown}`);
      }
    } else if (!CSS_FUNCTIONS.has(name)) {
      fail(`unsupported function ${name}() in ${where}`);
    }
  }
}

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");

/**
 * Validate an SVG document and return its re-serialized, checked form. Throws an Error that
 * names the problem when the source is outside the safe subset.
 */
export function checkSvgSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SVG_BYTES) fail("SVG source must be a string of at most 128 KiB");
  let doc;
  try {
    doc = parseXml(source, { preserveCdata: true, preserveDocumentType: true, preserveXmlDeclaration: true });
  } catch (err) {
    if (err instanceof RangeError) fail(`SVG nests elements too deeply (at most ${MAX_DEPTH} levels)`);
    const message = String(err?.message ?? err).split("\n")[0];
    fail(`malformed SVG (not well-formed XML): ${message}${/Attribute value expected/.test(message) ? "; quote every attribute value" : ""}`);
  }
  let root = null;
  for (const node of doc.children) {
    if (node.type === "element") root = node;
    else if (node.type === "doctype") fail("unsafe SVG content: <!DOCTYPE> is not allowed");
    else if (node.type === "pi") fail(`unsafe SVG content: processing instruction <?${node.name}?> is not allowed`);
    // xmldecl (dropped on output); comments are not kept by the parser.
  }
  if (!root || root.name !== "svg") fail(`malformed SVG document: the root element must be <svg>${root ? `, not <${root.name}>` : ""}`);
  let usesXlink = false;

  const element = (el, depth) => {
    if (depth > MAX_DEPTH) fail(`SVG nests elements too deeply (at most ${MAX_DEPTH} levels)`);
    const tag = el.name;
    if (UNSAFE_TAGS.test(tag) || /:(script|foreignObject|image|iframe)$/i.test(tag)) fail(`unsafe SVG content: <${tag}>`);
    if (!SVG_TAGS.has(tag)) fail(`unsupported SVG element <${tag}>. Allowed: ${[...SVG_TAGS].join(", ")}`);
    const attrs = [];
    for (const [name, value] of Object.entries(el.attributes)) {
      if (/^on/i.test(name)) fail(`unsafe SVG attribute ${name} on <${tag}>`);
      if (!SVG_ATTRS.has(name)) fail(`unsupported SVG attribute "${name}" on <${tag}>`);
      if (name === "xmlns" && value !== SVG_NS) fail(`unsafe SVG namespace on <${tag}>: xmlns must be "${SVG_NS}"`);
      if (name === "xmlns:xlink" && value !== XLINK_NS) fail(`unsafe SVG namespace on <${tag}>: xmlns:xlink must be "${XLINK_NS}"`);
      if (name === "href" || name === "xlink:href") {
        if (!ID_REF.test(value)) fail(`unsafe SVG ${name} on <${tag}>: only #id references are allowed`);
        if (name === "xlink:href") usesXlink = true;
      } else if (name !== "xmlns" && name !== "xmlns:xlink") {
        checkCss(value, `${name} on <${tag}>`);
      }
      if (name === "attributeName" && /href/i.test(value)) fail(`unsafe SVG animation of ${value} on <${tag}>`);
      attrs.push(` ${name}="${escapeAttr(value)}"`);
    }
    let body = "";
    for (const child of el.children) {
      if (child.type === "element") {
        if (tag === "style") fail("unsafe SVG content: <style> may contain only CSS text");
        body += element(child, depth + 1);
      } else if (child.type === "text") {
        if (tag === "style") checkCss(child.text, "<style>");
        body += escapeText(child.text);
      } else if (child.type === "cdata") {
        fail(`unsafe SVG content: CDATA sections are not allowed (in <${tag}>); write the text directly`);
      } else if (child.type === "pi") {
        fail(`unsafe SVG content: processing instruction <?${child.name}?> is not allowed`);
      }
    }
    if (depth === 0) {
      // Shown through an image data URI, an SVG without its namespace renders nothing, and an
      // xlink:href needs its prefix bound.
      if (!Object.hasOwn(el.attributes, "xmlns")) attrs.unshift(` xmlns="${SVG_NS}"`);
      if (usesXlink && !Object.hasOwn(el.attributes, "xmlns:xlink")) attrs.splice(1, 0, ` xmlns:xlink="${XLINK_NS}"`);
    }
    return `<${tag}${attrs.join("")}${body ? `>${body}</${tag}>` : "/>"}`;
  };

  return element(root, 0);
}
