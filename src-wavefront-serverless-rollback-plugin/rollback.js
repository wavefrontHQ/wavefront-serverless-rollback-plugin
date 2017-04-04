//
// Copyright (c) 2017 Wavefront. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


'use strict';

const CloudFormation = require('aws-sdk/clients/cloudformation');
const Lambda = require('aws-sdk/clients/lambda');
const ApiGateway = require('aws-sdk/clients/apigateway');
const IAM = require('aws-sdk/clients/iam');
const https = require('https');
const util = require('util');
const jsonfile = require('jsonfile');

module.exports.rollback = (event, context, callback) => {

  /*
  *   TODO:
  *   1. Implement cleanup if TTL reached
  *     - Remove API gateway
  *     - Remove Lambda function
  */


  var paramsFile = process.env.LAMBDA_TASK_ROOT + '/src-wavefront-serverless-rollback-plugin/params.json';
  var params = jsonfile.readFileSync(paramsFile);

  // Rollback using CloudFormation
  var cloudformation = new CloudFormation({});
  cloudformation.updateStack(params.CloudFormationRollbackParam, function(err, data) {

    const response = !err ?
      {
        statusCode: 200,
        body: 'SUCCESS: ' + JSON.stringify(data),
      }
      : {
        statusCode: 500,
        body: 'ERROR: ' + JSON.stringify(err),
      };

    console.log('Update stack response: ' + JSON.stringify(response));
    callback(null, response);
  });

  // Remove Wavefront alert
  console.log(JSON.stringify(event, null, 2))
  var alertData = JSON.parse(event.body);
  if (alertData && alertData.alertId) {
    var headers = {
      'Authorization': params.WavefrontApiParam.Authorization
    };

    var options = {
      host: params.WavefrontApiParam.WavefrontHost,
      path: '/api/v2/alert/' + alertData.alertId,
      method: 'DELETE',
      headers: headers
    };

    var req = https.request(options, function(res) {
      res.setEncoding('utf-8');

      var responseString = '';

      res.on('data', function(data) {
        responseString += data;
      });

      res.on('end', function() {
        console.log('remove alert response: ' + responseString);
        // var responseObject = JSON.parse(responseString);
      });
    });

    req.end();
  }

  // Remove self

  var apigateway = new ApiGateway({});
  apigateway.deleteResource(params.ApiGatewayParam, function(err, data) {

    const response = !err ?
      {
        statusCode: 200,
        body: 'SUCCESS: ' + JSON.stringify(data),
      }
      : {
        statusCode: 500,
        body: 'ERROR: ' + JSON.stringify(err),
      };

    console.log('Remove API gateway response: ' + JSON.stringify(response));
  });

  var iam = new IAM({});
  iam.deleteRolePolicy(params.RolePolicyParam, function(err, data) {

    var lambda = new Lambda({});
    lambda.deleteFunction(params.LambdaFunctionParam, function(err, data) {

      const response = !err ?
        {
          statusCode: 200,
          body: 'SUCCESS: ' + JSON.stringify(data),
        }
        : {
          statusCode: 500,
          body: 'ERROR: ' + JSON.stringify(err),
        };

      console.log('Remove lambda function response: ' + JSON.stringify(response));
    });

    const response = !err ?
      {
        statusCode: 200,
        body: 'SUCCESS: ' + JSON.stringify(data),
      }
      : {
        statusCode: 500,
        body: 'ERROR: ' + JSON.stringify(err),
      };

    console.log('Remove Role policy response: ' + JSON.stringify(response));

    if (err) return;

    iam.deleteRole({ RoleName: params.RolePolicyParam.RoleName }, function(err, data) {

      const response = !err ?
        {
          statusCode: 200,
          body: 'SUCCESS: ' + JSON.stringify(data),
        }
        : {
          statusCode: 500,
          body: 'ERROR: ' + JSON.stringify(err),
        };

      console.log('Remove Role response: ' + JSON.stringify(response));

    });
  });

};
