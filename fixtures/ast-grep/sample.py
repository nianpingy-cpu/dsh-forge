def handle_request(payload, context):
    result = process_payload(payload)
    return result

def process_payload(payload):
    return transform(payload, None)
