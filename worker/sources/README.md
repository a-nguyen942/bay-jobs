# Source adapters

Each adapter is a plain object with `id`, `label`, and an async `fetchListings()` method. That method returns an array of listing objects with `sourceJobId`, `title`, `company`, `location`, `url`, and `postedAt` (an ISO date string or `null`). Keep source-specific response parsing here; filtering and persistence belong in the monitor.

- **Greenhouse:** Figma is enabled using the public Job Board API. Use “Check for new jobs” in the inbox. Add or remove board entries in `config/sources.js` to change coverage. Requests time out after 15 seconds and require no API key.
- **GitHub repositories:** next adapter. Choose a repository first, inspect its data format and license, then map its structured data (or Markdown) to this listing format. There is no universal GitHub job format. A demo labeled GitHub is not a live GitHub importer.
- **LinkedIn / Handshake:** future alert-email or manual imports. No logged-in scraping or browser automation is included.

Sources must throw on request or format failures instead of returning an empty array. A failed fetch must not imply that jobs have closed. No adapter submits applications.

Reference: https://docs.greenhouse.io/job-board.html
