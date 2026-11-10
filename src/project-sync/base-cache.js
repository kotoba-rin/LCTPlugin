const isTextPath = (path) => /\.(?:md|txt|csv)$/i.test(path) || path === "LICENSE";

module.exports = { isTextPath };
