module.exports = (req, res) => {
  const app = require('../server');
  return app(req, res);
};
