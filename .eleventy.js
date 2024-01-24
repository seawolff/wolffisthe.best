const pluginRss = require("@11ty/eleventy-plugin-rss");
const { DateTime } = require("luxon");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("bundle.css");

  // Copy the `img/` directory
  eleventyConfig.addPassthroughCopy("img");

  // RSS config
  eleventyConfig.addPlugin(pluginRss);

  // Post Date
  eleventyConfig.addFilter("postDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj).toLocaleString(DateTime.DATE_MED);
  });

  return {
    passthroughFileCopy: true,
  };
};
