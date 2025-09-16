const express = require("express");
const bodyParser = require("body-parser");
const googleCalendarRoutes = require("./api/google-calendar");
const notionRoutes = require("./api/notion");

const app = express();

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Rutas
app.use("/google-calendar", googleCalendarRoutes);
app.use("/notion", notionRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
