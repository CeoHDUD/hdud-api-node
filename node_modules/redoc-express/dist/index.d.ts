import { Request, Response } from 'express';
import { Ioption } from './redoc-html-template';
declare function redocExpressMiddleware(options?: Ioption): (req: Request, res: Response) => void;
export default redocExpressMiddleware;
