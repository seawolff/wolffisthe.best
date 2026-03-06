const pluginRss = require("@11ty/eleventy-plugin-rss");
const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const { DateTime } = require("luxon");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("bundle.css");

  // Copy the `img/` directory
  eleventyConfig.addPassthroughCopy("img");

  // RSS config
  eleventyConfig.addPlugin(pluginRss);

  // Syntax highlighting
  eleventyConfig.addPlugin(syntaxHighlight);

  // Posts sorted newest first
  eleventyConfig.addCollection("postsByDate", function (collectionApi) {
    return collectionApi.getFilteredByTag("post").sort((a, b) => b.date - a.date);
  });

  // Post Date
  eleventyConfig.addFilter("postDate", (dateObj) => {
    return DateTime.fromJSDate(dateObj).toLocaleString(DateTime.DATE_MED);
  });

  return {
    passthroughFileCopy: true,
  };
};
