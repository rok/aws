Feature: Cell Geolocation Publish API

    Trusted clients can publish cell geolocation information,
    so it becomes available for querying.

    Background:

        Given I am run after the "Cell Geolocation API" feature
        And the endpoint is "{geolocationApiUrl}"
        And I store "$floor($random() * 100000000)" into "cellId"
        And I store "$floor($random() * 10000) + 10000" into "mccmnc"
        And I store "$floor($random() * 100) + 100" into "area"
        And I store "$random() * 50000" into "accuracy"
        And I store "$random() * 90" into "lat"
        And I store "$random() * 180" into "lng"

    Scenario: Provide cell geolocation

        When I POST to /cell with this JSON
            """
            {
            "cell": {cellId},
            "area": {area},
            "mccmnc": {mccmnc},
            "lat": {lat},
            "lng": {lng},
            "accuracy": {accuracy}
            }
            """
        Then the response status code should be 202

    Scenario: Query a cell

        Given I store "$millis()" into "ts"
        When I GET /cell?cell={cellId}&area={area}&mccmnc={mccmnc}&ts={ts}
        Then the response status code should be 200
        And the response Access-Control-Allow-Origin should be "*"
        And the response Content-Type should be "application/json"
        And the response should equal this JSON
            """
            {
            "lng": {lng},
            "lat": {lat},
            "accuracy": 5000
            }
            """
