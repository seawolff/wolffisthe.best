module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("bundle.css");

  // Copy the `img/` directory
  eleventyConfig.addPassthroughCopy("img");

  return {
    passthroughFileCopy: true,
  };
};
