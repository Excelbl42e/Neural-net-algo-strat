import { Router, type IRouter } from "express";
import healthRouter from "./health";
import accountsRouter from "./accounts";
import tradesRouter from "./trades";
import signalsRouter from "./signals";
import strategiesRouter from "./strategies";
import reportsRouter from "./reports";
import dashboardRouter from "./dashboard";
import brainRouter from "./brain";
import brokersRouter from "./brokers";
import configRouter from "./config";
import analysisRouter from "./analysis";
import candlesRouter from "./candles";
import journalRouter from "./journal";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(accountsRouter);
router.use(tradesRouter);
router.use(signalsRouter);
router.use(strategiesRouter);
router.use(reportsRouter);
router.use(dashboardRouter);
router.use(brainRouter);
router.use(brokersRouter);
router.use(configRouter);
router.use(analysisRouter);
router.use(candlesRouter);
router.use(journalRouter);

export default router;
