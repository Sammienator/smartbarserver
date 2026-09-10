function asyncHandler(fn) {
  if (typeof fn !== "function") {
    console.error(
      "[asyncHandler] Expected a function but got:",
      fn,
      "- check that the controller export exists and the name matches"
    );
    return (req, res) => {
      res.status(500).json({
        error: "Server misconfiguration: route handler is not a function",
      });
    };
  }

  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
