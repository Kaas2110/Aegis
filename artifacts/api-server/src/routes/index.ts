import { Router, type IRouter } from "express";
import healthRouter from "./health";
import oddsRouter from "./odds";
import matchesRouter from "./matches";
import bookmakersRouter from "./bookmakers";
import analyticsRouter from "./analytics";
import teamsRouter from "./teams";
import adminRouter from "./admin";
import adminAuthRouter from "./adminAuth";
import configRouter from "./config";
import eventsRouter from "./events";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/odds", oddsRouter);
router.use("/matches", matchesRouter);
router.use("/bookmakers", bookmakersRouter);
router.use("/analytics", analyticsRouter);
router.use("/teams", teamsRouter);
router.use("/config", configRouter);
router.use("/events", eventsRouter);

// Auth endpoints (login/logout/whoami) — public, mounted BEFORE admin router so
// they aren't gated by the admin auth middleware. They consume `req.body.token`
// to compare against ADMIN_TOKEN and issue an HttpOnly session cookie.
router.use("/admin", adminAuthRouter);

// Admin business endpoints (settings, retrain, metrics, ...). Cookie session
// from /admin/login is required; legacy X-Admin-Token header is no longer
// accepted now that the inline /api/admin-ui surface has been removed in
// favor of the standalone admin-web artifact.
router.use("/admin", adminRouter);

export default router;
