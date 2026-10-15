use crate::context::service::ChatMessage;
use serde_json::{json, Value};

pub fn completion_body(provider:&Value,messages:&[ChatMessage],output:usize,json_response:bool,legacy_thinking:Option<&str>)->Result<Value,String> {
    let model=provider["model"].as_str().ok_or("请求型号缺失")?;
    let provider_type=provider["id"].as_str().ok_or("服务商类型缺失")?;
    let capability=provider.get("capability").filter(|c|c.is_object());
    let requested=provider["thinking"].as_str().or(legacy_thinking).unwrap_or("off");
    let thinking=match requested {"fast"=>"off","balanced"=>"on","deep"=>"high",other=>other};
    if let Some(value)=capability {
        let cap:super::model_catalog::CatalogModel=serde_json::from_value(value.clone()).map_err(|e|e.to_string())?;
        cap.validate_thinking(thinking)?;
        if output==0 || output>cap.output_limit {return Err("输出预算超过模型容量".into());}
        if json_response && !cap.json_output {return Err("所选模型不支持 JSON 输出".into());}
    }
    let output_parameter=capability.and_then(|c|c["output_parameter"].as_str()).or_else(||provider["overrides"]["output_parameter"].as_str()).unwrap_or("max_tokens");
    if !["max_tokens","max_completion_tokens"].contains(&output_parameter) {return Err("输出参数名称无效".into());}
    let mut body=json!({"model":model,"messages":messages});
    body[output_parameter]=json!(output);
    if json_response {if provider["overrides"]["json_output"].as_bool()==Some(false){return Err("所选模型未启用 JSON 输出能力".into());}body["response_format"]=json!({"type":"json_object"});}
    match provider_type {
        "deepseek" => {body["thinking"]=json!({"type":if thinking=="off" {"disabled"}else{"enabled"}});if ["low","high","max"].contains(&thinking) {body["reasoning_effort"]=json!(thinking);}},
        "qwen" => body["enable_thinking"]=json!(thinking!="off"),
        "kimi" if model=="kimi-k3" => body["reasoning_effort"]=json!(thinking),
        "kimi" if model=="kimi-k2.6" => body["thinking"]=json!({"type":if thinking=="off"{"disabled"}else{"enabled"}}),
        "kimi" if model.starts_with("kimi-k2.7-code") => {},
        "glm" if model.starts_with("glm-5.3") => {body["thinking"]=json!({"type":"enabled"});body["reasoning_effort"]=json!(thinking);},
        "glm" if ["glm-4.5","glm-4.6","glm-4.7"].iter().any(|prefix|model.starts_with(prefix)) => body["thinking"]=json!({"type":if thinking=="off"{"disabled"}else{"enabled"}}),
        "custom"=>match provider["overrides"]["thinking_parameter"].as_str().unwrap_or("none") {
            "none"=>{},"thinking"=>body["thinking"]=json!({"type":if thinking=="off"{"disabled"}else{"enabled"}}),
            "enable_thinking"=>body["enable_thinking"]=json!(thinking!="off"),"reasoning_effort"=>body["reasoning_effort"]=json!(thinking),
            _=>return Err("自定义思考参数名称无效".into()),
        },
        _=>{},
    }
    Ok(body)
}
