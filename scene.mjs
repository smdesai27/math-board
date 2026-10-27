/** Safe, bounded Excalidraw scene subset. No images, embeds, hyperlinks or custom metadata. */
export const ELEMENT_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
  "freedraw",
  "text",
  "frame",
  "magicframe",
]);
const KEYS = new Set(
  `id type x y width height angle strokeColor backgroundColor fillStyle strokeWidth strokeStyle roughness opacity groupIds frameId index roundness seed version versionNonce isDeleted boundElements updated link locked points pressures simulatePressure lastCommittedPoint startBinding endBinding startArrowhead endArrowhead elbowed fixedSegments startIsSpecial endIsSpecial text originalText fontSize fontFamily textAlign verticalAlign containerId autoResize lineHeight name`.split(
    " ",
  ),
);
function bounded(value, depth = 0) {
  if (depth > 10) throw new Error("scene nesting too deep");
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw new Error("invalid scene number");
  if (typeof value === "string" && value.length > 10000)
    throw new Error("scene string too long");
  if (Array.isArray(value)) {
    if (value.length > 4000) throw new Error("scene array too long");
    return value.map((v) => bounded(v, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(k))
        throw new Error("unsafe scene key");
      out[k] = bounded(v, depth + 1);
    }
    return out;
  }
  return value;
}
export function sanitizeElements(elements) {
  if (!Array.isArray(elements) || elements.length > 2000)
    throw new Error("elements must be an array of at most 2000 items");
  const ids = new Set();
  return elements.map((raw) => {
    if (!raw || !ELEMENT_TYPES.has(raw.type))
      throw new Error(
        "unsupported Excalidraw element (images and embeds are disabled)",
      );
    if (
      typeof raw.id !== "string" ||
      !raw.id ||
      raw.id.length > 100 ||
      ids.has(raw.id)
    )
      throw new Error("invalid or duplicate element id");
    ids.add(raw.id);
    for (const key of ["x", "y", "width", "height"]) {
      if (
        typeof raw[key] !== "number" ||
        !Number.isFinite(raw[key]) ||
        Math.abs(raw[key]) > 1e7
      )
        throw new Error(`invalid element ${key}`);
    }
    if (raw.width < 0 || raw.height < 0)
      throw new Error("negative element size");
    if (
      ["line", "arrow", "freedraw"].includes(raw.type) &&
      (!Array.isArray(raw.points) ||
        raw.points.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 2 ||
            p.some((n) => typeof n !== "number" || !Number.isFinite(n)),
        ))
    )
      throw new Error("invalid element points");
    if (raw.type === "text" && typeof raw.text !== "string")
      throw new Error("invalid element text");
    const out = {};
    for (const [key, value] of Object.entries(raw))
      if (KEYS.has(key)) out[key] = bounded(value);
    for (const key of [
      "angle",
      "strokeWidth",
      "roughness",
      "opacity",
      "seed",
      "version",
      "versionNonce",
      "updated",
      "fontSize",
      "fontFamily",
      "lineHeight",
    ]) {
      if (out[key] !== undefined && typeof out[key] !== "number")
        throw new Error(`invalid element ${key}`);
    }
    for (const key of [
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeStyle",
      "text",
      "originalText",
      "textAlign",
      "verticalAlign",
    ]) {
      if (out[key] !== undefined && typeof out[key] !== "string")
        throw new Error(`invalid element ${key}`);
    }
    for (const key of [
      "isDeleted",
      "locked",
      "simulatePressure",
      "autoResize",
      "elbowed",
      "startIsSpecial",
      "endIsSpecial",
    ]) {
      if (out[key] !== undefined && typeof out[key] !== "boolean")
        throw new Error(`invalid element ${key}`);
    }
    for (const key of [
      "frameId",
      "containerId",
      "index",
      "name",
      "startArrowhead",
      "endArrowhead",
    ]) {
      if (out[key] != null && typeof out[key] !== "string")
        throw new Error(`invalid element ${key}`);
    }
    if (out.fontSize !== undefined && (out.fontSize < 1 || out.fontSize > 1000))
      throw new Error("invalid font size");
    if (
      out.lineHeight !== undefined &&
      (out.lineHeight <= 0 || out.lineHeight > 10)
    )
      throw new Error("invalid line height");
    if (
      out.groupIds !== undefined &&
      (!Array.isArray(out.groupIds) ||
        out.groupIds.some((v) => typeof v !== "string"))
    )
      throw new Error("invalid groups");
    if (
      out.boundElements != null &&
      (!Array.isArray(out.boundElements) ||
        out.boundElements.some(
          (v) =>
            !v ||
            typeof v.id !== "string" ||
            !["arrow", "text"].includes(v.type),
        ))
    )
      throw new Error("invalid bound elements");
    for (const key of ["startBinding", "endBinding"]) {
      const binding = out[key];
      if (
        binding != null &&
        (typeof binding !== "object" ||
          typeof binding.elementId !== "string" ||
          typeof binding.focus !== "number" ||
          typeof binding.gap !== "number")
      )
        throw new Error("invalid binding");
    }
    if (
      out.roundness != null &&
      (typeof out.roundness !== "object" ||
        !Number.isInteger(out.roundness.type))
    )
      throw new Error("invalid roundness");
    if (
      out.pressures !== undefined &&
      (!Array.isArray(out.pressures) ||
        out.pressures.some((n) => typeof n !== "number" || n < 0 || n > 1))
    )
      throw new Error("invalid pressures");
    out.link = null;
    return out;
  });
}
