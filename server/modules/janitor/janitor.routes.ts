import { Router } from 'express';

import { AppError } from '@/shared/index.js';

import type { Janitor } from './janitor.service.js';

/** Authenticated worker routes for the service inbox; user confirmation is required for every file move. */
export function createJanitorRouter(service:Janitor|null):Router {
const janitorRoutes=Router();
janitorRoutes.get('/',async(_request,response)=>{
  if(!service){response.json({enabled:false});return;}
  try{response.set('Cache-Control','no-store').json({enabled:true,...await service.status()});}
  catch{response.status(503).json({error:'Janitor state is unavailable.'});}
});
janitorRoutes.get('/preview/:id',async(request,response)=>{
if(!service){response.status(404).json({error:'Janitor is not enabled.'});return;}
  try {response.set('Cache-Control','no-store').json(await service.preview(String(request.params.id)));}
  catch(error){response.status(error instanceof AppError?error.statusCode:409).json({error:'File is unavailable or changed. Scan again.'});}
});
janitorRoutes.post('/:action',async(request,response)=>{
if(!service){response.status(404).json({error:'Janitor is not enabled.'});return;}
  if(!request.is('application/json')||request.get('Sec-Fetch-Site')==='cross-site'){response.status(403).json({error:'Same-origin JSON required.'});return;}
  try{
    if(request.params.action==='scan'){response.status(202).json(await service.startScan());return;}
    if(request.params.action==='read'){response.json(await service.markRead());return;}
    if(request.params.action==='preferences'&&typeof request.body?.nightlyEnabled==='boolean'){response.json(await service.preferences(request.body.nightlyEnabled));return;}
    const action=request.params.action;
    if(!['keep','trash','restore'].includes(action)||!Array.isArray(request.body?.ids)||request.body.ids.length<1||request.body.ids.length>50||request.body.ids.some((id:unknown)=>typeof id!=='string')){
      response.status(400).json({error:'Select between 1 and 50 proposals.'});return;
    }
    response.json(await service.decide([...new Set<string>(request.body.ids)],action as 'keep'|'trash'|'restore'));
  }catch(error){response.status(error instanceof AppError?error.statusCode:500).json({error:error instanceof AppError?error.message:'Janitor operation failed. Existing files were preserved; inspect the inbox before retrying.'});}
});

return janitorRoutes;
}
