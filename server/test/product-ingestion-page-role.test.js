'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {assessSingleProductEvidence,templateFailureSignature,recordTemplateObservation,templateDriftDecision}=require('../services/product-ingestion-page-role');
const {sandboxValidationProgress}=require('../services/product-ingestion-site-cognition');

test('single-product evidence is based on page facts instead of URL paths',()=>{
  const product={url:'https://example.com/anything/42',html:'<script type="application/ld+json">{"@type":"Product","name":"Oak Chair","sku":"C-42"}</script><main><h1>Oak Chair</h1><img src="a"><img src="b"></main>'};
  const scene={url:'https://example.com/products/looks-like-one',html:'<script type="application/ld+json">{"@type":"ImageGallery","name":"Living room ideas"}</script><main><h1>Living room ideas</h1><p>Browse the complete scene.</p></main>'};
  assert.equal(assessSingleProductEvidence(product).role,'product_detail');
  assert.equal(assessSingleProductEvidence(scene).role,'suspected_non_product');
  assert.equal(assessSingleProductEvidence({url:'https://example.com/view/99',html:'<main class="product-detail"><section class="product-info"><h1>Memory Chair</h1><p>Model: M-99</p><img src="a"><img src="b"></section></main>'}).role,'product_detail');
});

test('template learning requires a cohort and repeated identical failure is skipped',()=>{
  const page=url=>({url,html:'<script type="application/ld+json">{"@type":"Product","name":"Chair","sku":"C-1"}</script><main><h1>Chair</h1><img src="a"><img src="b"></main>'});
  const error={code:'SITE_RULE_TEMPLATE_STALE',template_failures:[{message:'TEMPLATE_SIGNALS_MISSING:PRODUCT_GALLERY'}]};
  const assessment=assessSingleProductEvidence(page('https://example.com/a'));
  const signature=templateFailureSignature(page('https://example.com/a'),error);
  let snapshot=recordTemplateObservation({}, {signature,source_url:'https://example.com/a',error_code:error.code,assessment,checkpoint_index:10});
  assert.equal(templateDriftDecision(snapshot,{signature,source_url:'https://example.com/a',assessment}).reason,'TEMPLATE_COHORT_NOT_ESTABLISHED');
  snapshot=recordTemplateObservation(snapshot,{signature,source_url:'https://example.com/b',error_code:error.code,assessment,checkpoint_index:12});
  assert.deepEqual(templateDriftDecision(snapshot,{signature,source_url:'https://example.com/b',assessment}),{action:'learn_template',reason:'QUALIFIED_TEMPLATE_COHORT',resume_checkpoint:10});
  snapshot=recordTemplateObservation(snapshot,{signature,source_url:'https://example.com/a',error_code:error.code,assessment,checkpoint_index:10});
  assert.equal(templateDriftDecision(snapshot,{signature,source_url:'https://example.com/a',assessment}).reason,'SAME_PAGE_SAME_FAILURE_NO_IMPROVEMENT');
});

function result(accepted,rejectedErrors=[]){
  const acceptedRows=Array.from({length:accepted},(_,index)=>({source_url:`https://example.com/p/${index}`,accepted:true,validation_errors:[]}));
  const rejected=rejectedErrors.map((errors,index)=>({source_url:`https://example.com/f/${index}`,accepted:false,validation_errors:errors}));
  return {passed:false,summary:{products_accepted:acceptedRows.length,products_rejected:rejected.length,failures:0},accepted_products:acceptedRows,rejected_products:rejected,failures:[]};
}
test('new rules must improve pass rate on the same independent validation set',()=>{
  const before=result(1,[['PRODUCT_V2_CONFIGURATIONS_MISSING']]);
  const same=result(1,[['PRODUCT_V2_CONFIGURATIONS_MISSING']]);
  const better={...result(2,[]),passed:true};
  assert.deepEqual(sandboxValidationProgress(before,same),{comparable:true,improved:false,before_rate:.5,after_rate:.5,same_failure:true});
  assert.equal(sandboxValidationProgress(before,better).improved,true);
  assert.equal(sandboxValidationProgress(before,result(1,[['OTHER_ERROR'],['EXTRA']])).comparable,false);
});
