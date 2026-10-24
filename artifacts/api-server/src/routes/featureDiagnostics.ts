/** Mounted under the existing /api/admin router; the local guard also protects
 * this router if a future refactor mounts it elsewhere. No listener is opened. */
import {Router,type IRouter,type RequestHandler} from 'express';
import {requireAdminSession} from './adminAuth';
import {featureDiagnosticAdmin} from '../services/FeatureDiagnosticAdmin';

type Service={handle:(input:{method:string;url:string})=>Promise<{status:number;headers:Record<string,string>;body:unknown}>};
export function featureDiagnosticsHandler(service:Service=featureDiagnosticAdmin):RequestHandler{
 return async(req,res)=>{
  const result=await service.handle({method:req.method,url:'/admin/feature-diagnostics'+req.url});
  for(const[name,value]of Object.entries(result.headers))res.set(name,value);
  res.status(result.status).json(result.body);
 };
}
export function createFeatureDiagnosticsRouter(service:Service=featureDiagnosticAdmin):IRouter{
 const router=Router();router.use(requireAdminSession);router.use(featureDiagnosticsHandler(service));return router;
}
export default createFeatureDiagnosticsRouter();
