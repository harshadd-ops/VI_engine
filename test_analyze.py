import requests
import json

url = "http://localhost:5000/api/analyze"
# A small polygon in India (Nagpur area)
payload = {
    "geometry": {
        "type": "Polygon",
        "coordinates": [[
            [79.088, 21.145],
            [79.089, 21.145],
            [79.089, 21.146],
            [79.088, 21.146],
            [79.088, 21.145]
        ]]
    }
}

try:
    print(f"Sending POST request to {url}...")
    response = requests.post(url, json=payload, timeout=60)
    print(f"Status Code: {response.status_code}")
    if response.status_code == 200:
        print("Success!")
        data = response.json()
        print(f"Features returned: {len(data.get('features', []))}")
        print(f"Confidence: {data.get('farm_summary', {}).get('confidence')}")
    else:
        print(f"Error: {response.text}")
except Exception as e:
    print(f"Exception: {e}")
