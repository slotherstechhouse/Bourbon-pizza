import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicRouter from "./public";
import staffRouter from "./staff";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicRouter);
router.use(staffRouter);

export default router;
