'use strict';
const express=require('express');
const {success,error}=require('../utils/response');
const {createPublicProductLibrary}=require('../services/public-product-library');
const {publicProductMaterials}=require('../services/official-material-selection');

module.exports=function routes(db){
  const router=express.Router(),library=createPublicProductLibrary(db);
  const handle=fn=>async(req,res)=>{res.set('Cache-Control','private, max-age=60');try{return success(res,await fn(req));}catch(err){if(err.status)return error(res,err.message,err.status);console.error('Public product library:',err.code||err.name);return error(res,'公共产品素材库读取失败',500);}};
  router.get('/',handle(req=>library.listProducts({...req.query,include_payload:false},true)));
  router.get('/facets',handle(()=>library.facets()));
  router.get('/:id/materials',handle(req=>publicProductMaterials(db,req.params.id,req.query||{})));
  router.get('/:id',handle(req=>library.getProduct(req.params.id,true)));
  return router;
};
