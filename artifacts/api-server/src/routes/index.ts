import { Router, type IRouter } from "express";
import healthRouter from "./health";
import oddsRouter from "./odds";
import matchesRouter from "./matches";
import bookmakersRouter from "./bookmakers";
import analyticsRouter from "./analytics";
import teamsRouter from "./teams";
import adminRouter from "./admin";
import adminUiRouter from "./adminUi";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/odds", oddsRouter);
router.use("/matches", matchesRouter);
router.use("/bookmakers", bookmakersRouter);
router.use("/analytics", analyticsRouter);
router.use("/teams", teamsRouter);
// Веб-UI монтируется по отдельному пути ДО /admin (без auth-middleware
// admin-роутера), чтобы саму страницу можно было открыть без токена — токен
// вводится в форме и хранится в localStorage браузера.
router.use("/admin-ui", adminUiRouter);
router.use("/admin", adminRouter);

export default router;
